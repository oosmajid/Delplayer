// ecosystem.config.js
module.exports = {
  apps: [{
    // نام برنامه در pm2
    name: 'delplayer', 
    
    // مسیر فایل اصلی اسکریپت
    script: 'server.js', 

    node_args: "--dns-result-order=ipv4first",
    
    // تعداد نمونه‌هایی که می‌خواهید اجرا شود (برای حالت cluster)
    // برای اکثر برنامه‌ها 1 کافی است
    instances: 1, 
    
    // راه‌اندازی مجدد خودکار در صورت خطا
    autorestart: true, 
    
    // حداکثر حافظه‌ای که برنامه می‌تواند استفاده کند
    max_memory_restart: '1G',

    env: {
      NODE_ENV: 'production',
      // پشت nginx است، پس IP واقعی کاربر از x-forwarded-for خوانده می‌شود.
      // اگر روزی nginx حذف شد، این را روی '0' بگذارید.
      TRUST_PROXY: '1',
    },

    // اگر از نسخه خاصی از node استفاده می‌کنید
    // interpreter: '/home/user/.nvm/versions/node/v18.17.1/bin/node', 
  }],
};