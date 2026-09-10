import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      }
    }
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1000,
    // خرائط المصدر كانت تُبنى ثم تُحذف في deploy.ps1 قبل الرفع — بناء بلا فائدة.
    sourcemap: false,
    rollupOptions: {
      output: {
        // فصل المكتبات الثقيلة في حزم مستقلة بدل تركها تُدمج في حزمة الدخول.
        // ملاحظة: jspdf/html2canvas تُركا خارج القائمة عمداً — تجميعهما يدوياً
        // كان يجعل Rollup يعتبر الحزمة تابعاً ثابتاً للدخول فيضيف لها
        // modulepreload (‎+593KB على كل مستخدم)، بينما استيرادهما الديناميكي
        // داخل SalesDataPage يقسّمهما تلقائياً ويحمّلهما عند تصدير PDF فقط.
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-xlsx': ['xlsx'],
          'vendor-leaflet': ['leaflet'],
        },
      },
    },
  }
})
