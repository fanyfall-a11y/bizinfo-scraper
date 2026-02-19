// Gmail 자동 전송 모듈
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

async function sendDailyReport({ toEmail, subject, bodyText, attachmentDir }) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
  });

  // 첨부파일 수집 (PNG 이미지 + TXT 파일)
  const attachments = [];
  if (attachmentDir && fs.existsSync(attachmentDir)) {
    const walk = (dir) => {
      fs.readdirSync(dir).forEach((file) => {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          walk(fullPath);
        } else if (file.endsWith('.png') || file.endsWith('.txt')) {
          attachments.push({ filename: file, path: fullPath });
        }
      });
    };
    walk(attachmentDir);
  }

  const mailOptions = {
    from: `"비즈인포 자동수집" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject,
    text: bodyText,
    attachments,
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`📧 이메일 전송 완료: ${info.messageId}`);
  return info;
}

module.exports = { sendDailyReport };
