const crypto = require('crypto');
const ForumPost = require('../models/ForumPost');
const ForumPostReward = require('../models/ForumPostReward');
const VendorForumRule = require('../models/VendorForumRule');
const VendorVoucher = require('../models/VendorVoucher');
const Vendor = require('../models/Vendor');
const Notification = require('../models/Notification');
const { notifyStudent } = require('./persistence');

const generateVoucherCode = (vendorName = 'QUAY') => {
    const prefix = String(vendorName)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 4)
        .toUpperCase() || 'FOOD';
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `SV${prefix}${rand}`;
};

const recalcPostInteractions = async (postId) => {
    const post = await ForumPost.findById(postId);
    if (!post) return null;
    post.interactionCount = (post.voteCount || 0) + (post.commentCount || 0);
    await post.save();
    return post;
};

const issueVoucherFromReward = async (req, reward, post) => {
    if (!reward || reward.status === 'issued' || reward.status === 'cancelled') return null;
    if (post.interactionCount < reward.interactionThreshold) return null;

    const existing = await VendorVoucher.findOne({ forumReward: reward._id });
    if (existing) return existing;

    const vendor = await Vendor.findById(reward.vendor);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (reward.validDays || 14));

    let code;
    for (let i = 0; i < 5; i += 1) {
        code = generateVoucherCode(vendor?.name);
        const dup = await VendorVoucher.findOne({ code });
        if (!dup) break;
    }

    const voucher = await VendorVoucher.create({
        vendor: reward.vendor,
        code,
        discountAmount: reward.discountAmount,
        minOrder: reward.minOrder || 0,
        issuedTo: post.author,
        forumPost: post._id,
        forumReward: reward._id,
        status: 'active',
        expiresAt,
    });

    reward.status = 'issued';
    reward.voucherIssued = voucher._id;
    reward.issuedAt = new Date();
    await reward.save();

    const amount = Number(reward.discountAmount).toLocaleString('vi-VN');
    await notifyStudent(req, {
        userId: post.author,
        title: '🎁 Bạn nhận voucher từ quầy!',
        message: `Bài viết của bạn đạt ${post.interactionCount} tương tác. Mã ${code} giảm ${amount}đ — dùng khi đặt món quầy ${vendor?.name || ''}.`,
        type: 'SYSTEM',
    });

    const io = req?.app?.get('socketio');
    if (io) {
        io.to(`user_${post.author}`).emit('voucher_received', {
            code: voucher.code,
            discountAmount: voucher.discountAmount,
            vendorName: vendor?.name,
        });
    }

    return voucher;
};

const APPROVED_FILTER = { $in: ['approved', null] };

const isPostApproved = (post) => {
    if (!post?.isActive) return false;
    return !post.status || post.status === 'approved';
};

/** Đồng bộ ForumPostReward từ quy tắc chung của quầy */
const ensurePostRewardFromGlobalRule = async (vendorId, postId, createdBy) => {
    const rule = await VendorForumRule.findOne({ vendor: vendorId, isActive: true });
    if (!rule) return null;

    const post = await ForumPost.findById(postId);
    if (!post || !isPostApproved(post)) return null;

    const issued = await ForumPostReward.findOne({ post: postId, vendor: vendorId, status: 'issued' });
    if (issued) return issued;

    const status = (post.interactionCount || 0) >= rule.interactionThreshold ? 'eligible' : 'pending';

    return ForumPostReward.findOneAndUpdate(
        { post: postId, vendor: vendorId },
        {
            post: postId,
            vendor: vendorId,
            createdBy: createdBy || rule.createdBy,
            interactionThreshold: rule.interactionThreshold,
            discountAmount: rule.discountAmount,
            minOrder: rule.minOrder,
            validDays: rule.validDays,
            status,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
};

/** Áp dụng quy tắc chung cho mọi bài đã duyệt của quầy */
const syncAllPostRewardsForVendor = async (vendorId, createdBy) => {
    const posts = await ForumPost.find({
        vendor: vendorId,
        isActive: true,
        $or: [{ status: 'approved' }, { status: { $exists: false } }],
    }).select('_id interactionCount');

    for (const p of posts) {
        const reward = await ensurePostRewardFromGlobalRule(vendorId, p._id, createdBy);
        if (reward && (p.interactionCount || 0) >= reward.interactionThreshold) {
            // checkForumRewardsForPost sẽ xử lý từng bài khi cần
        }
    }
};

/** Sau vote/comment — cập nhật đếm và tự tặng voucher nếu đủ ngưỡng */
const checkForumRewardsForPost = async (req, postId) => {
    const post = await recalcPostInteractions(postId);
    if (!post || !isPostApproved(post)) return;

    await ensurePostRewardFromGlobalRule(post.vendor, postId);

    const rewards = await ForumPostReward.find({
        post: postId,
        status: { $in: ['pending', 'eligible'] },
    });

    for (const reward of rewards) {
        if (post.interactionCount >= reward.interactionThreshold) {
            if (reward.status === 'pending') {
                reward.status = 'eligible';
                await reward.save();

                const vendor = await Vendor.findById(reward.vendor);
                const io = req?.app?.get('socketio');
                if (vendor?.owner) {
                    const noti = await Notification.create({
                        audience: 'vendor',
                        recipientId: vendor.owner,
                        title: 'Bài forum đủ tương tác!',
                        message: `Bài review món tại quầy bạn đạt ${post.interactionCount} tương tác (vote + bình luận). Vào "Diễn đàn & Voucher" để tặng mã giảm giá cho sinh viên.`,
                        type: 'SYSTEM',
                        actionLink: 'forum',
                        isRead: false,
                    });
                    if (io) {
                        io.emit(`vendor_notification_${String(vendor.owner)}`, noti);
                    }
                }
            }
            await issueVoucherFromReward(req, reward, post);
        }
    }
};

const normalizeVendorId = (id) => {
    if (id == null) return '';
    if (typeof id === 'object' && id._id != null) return String(id._id);
    return String(id);
};

const lookupUserVoucher = async ({ code, userId }) => {
    return VendorVoucher.findOne({
        code: String(code).trim().toUpperCase(),
        issuedTo: userId,
        status: 'active',
    });
};

const validateVoucherForOrder = async ({ code, userId, vendorId, orderTotal }) => {
    const voucher = await lookupUserVoucher({ code, userId });

    if (!voucher) return { error: 'Mã voucher không hợp lệ hoặc bạn không sở hữu mã này.' };
    if (normalizeVendorId(voucher.vendor) !== normalizeVendorId(vendorId)) {
        return { error: 'Mã voucher không áp dụng cho quầy này.' };
    }
    if (voucher.expiresAt && voucher.expiresAt < new Date()) {
        voucher.status = 'expired';
        await voucher.save();
        return { error: 'Voucher đã hết hạn.' };
    }
    if (orderTotal < (voucher.minOrder || 0)) {
        return { error: `Đơn tối thiểu ${Number(voucher.minOrder).toLocaleString('vi-VN')}đ để dùng voucher.` };
    }

    const discount = Math.min(voucher.discountAmount, orderTotal);
    return { voucher, discount };
};

const markVoucherUsed = async (voucherId, orderId) => {
    await VendorVoucher.findByIdAndUpdate(voucherId, {
        status: 'used',
        usedAt: new Date(),
        usedOnOrder: orderId,
    });
};

module.exports = {
    generateVoucherCode,
    recalcPostInteractions,
    checkForumRewardsForPost,
    issueVoucherFromReward,
    validateVoucherForOrder,
    markVoucherUsed,
    lookupUserVoucher,
    normalizeVendorId,
    ensurePostRewardFromGlobalRule,
    syncAllPostRewardsForVendor,
    isPostApproved,
    APPROVED_FILTER,
};
