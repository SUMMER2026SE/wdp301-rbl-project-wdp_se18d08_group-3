/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
<<<<<<< HEAD
    "./src/**/*.{js,jsx,ts,tsx}", 
=======
    "./src/**/*.{js,jsx,ts,tsx}", // Quét tất cả file trong thư mục src
>>>>>>> cb42494 (Feat: build complete Login UI with multi-language and Vendor registration)
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      colors: {
<<<<<<< HEAD
        
=======
        // Định nghĩa màu Cam FPT để dùng cho chuẩn thương hiệu
>>>>>>> cb42494 (Feat: build complete Login UI with multi-language and Vendor registration)
        fpt: '#F27124', 
      },
      borderRadius: {
        '4xl': '2rem',
        '5xl': '2.5rem',
      }
    },
  },
  plugins: [],
}