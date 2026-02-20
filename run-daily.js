// 매일 자동 실행 스크립트
// 1. 새 공고 수집 (auto.js 로직)
// 2. 블로그 글 + 카드뉴스 이미지 생성 (blog-generator.js 로직)
// 3. Gmail로 결과 전송

require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { sendDailyReport } = require('./mailer');

const BASE_URL = 'https://www.bizinfo.go.kr';
const LIST_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do?schPblancDiv=01';
const DB_FILE = path.join(__dirname, 'collected_ids.json');
const LOG_FILE = path.join(__dirname, 'auto_log.txt');
const TO_EMAIL = process.env.TO_EMAIL || 'nagairams1@gmail.com';

function log(msg) {
  const line = `[${new Date().toLocaleString('ko-KR')}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
  }
  return {};
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

function extractId(url) {
  const match = url.match(/pblancId=([A-Z0-9_]+)/);
  return match ? match[1] : null;
}

function sanitize(name) {
  return name.replace(/[\/\\:*?"<>|\n\r]/g, '_').trim().slice(0, 80);
}

function extractRegion(title, details) {
  const regionMatch = title.match(/^\[([가-힣]+)\]/);
  if (regionMatch) return regionMatch[1];
  const jza = details.find(d => d.label.includes('지자체') || d.label.includes('소관부처'));
  if (jza) {
    const regions = ['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주'];
    for (const r of regions) {
      if (jza.value.includes(r)) return r;
    }
  }
  return '전국';
}

async function getNewItems(page, maxPages = 5) {
  const db = loadDB();
  const newItems = [];
  let currentPage = 1;
  let hitExisting = false;

  while (currentPage <= maxPages) {
    const url = currentPage === 1 ? LIST_URL : `${LIST_URL}&cpage=${currentPage}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('div.table_Type_1 td.txt_l a[href*="pblancId"]').forEach(a => {
        const title = a.innerText.trim();
        const href = a.href;
        const tds = Array.from(a.closest('td')?.parentElement?.querySelectorAll('td') || []);
        const date = tds[6]?.innerText?.trim() || tds[5]?.innerText?.trim() || '';
        if (title && href && title.length > 5) results.push({ title, url: href, date });
      });
      return results;
    });

    if (items.length === 0) break;

    let newCount = 0;
    for (const item of items) {
      const id = extractId(item.url);
      if (id && db[id]) { hitExisting = true; continue; }
      newItems.push(item);
      newCount++;
    }

    log(`페이지 ${currentPage}: ${items.length}개 중 ${newCount}개 신규`);
    if (hitExisting && newCount === 0) break;

    const hasNext = await page.evaluate(cp => {
      const links = Array.from(document.querySelectorAll('.page_wrap a'));
      return links.some(a => a.innerText.trim() === String(cp + 1));
    }, currentPage);

    if (!hasNext) break;
    currentPage++;
  }

  return newItems;
}

async function scrapeDetail(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    return await page.evaluate(() => {
      let title = '';
      for (const h of document.querySelectorAll('h2, h3')) {
        const t = h.innerText.trim();
        if (t.length > title.length && t.length > 5 &&
          !['정책정보','지원사업 공고','활용정보','고객알림','이용안내'].includes(t)) title = t;
      }

      const details = [];
      document.querySelectorAll('li').forEach(li => {
        const label = li.querySelector('.s_title')?.innerText.trim();
        const value = li.querySelector('.txt')?.innerText.replace(/\s+/g, ' ').trim();
        if (label && value) details.push({ label, value });
      });

      const dateEl = document.querySelector('.date, .reg_date, .write_date');
      const regDate = dateEl?.innerText?.replace(/[^0-9\.\-]/g, '').trim() || '';

      return { title, details, regDate };
    });
  } catch {
    log(`접속 실패: ${url}`);
    return null;
  }
}

// Gemini AI로 뉴스카드 멘트 생성
async function generateMent(item) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const overview = item.details.find(d => d.label.includes('사업개요'));
    const target = item.details.find(d => d.label.includes('지원대상'));
    const amount = item.details.find(d => d.label.includes('지원금액') || d.label.includes('지원규모'));

    const prompt = `다음 지원사업 공고를 SNS 뉴스카드용 멘트로 작성해줘.
- 반드시 3줄로 작성
- 각 줄마다 이모지 1개 포함
- 공고명에서 핵심 키워드(지역, 대상, 혜택)를 뽑아서 구체적으로 작성
- "지원사업 공고가 등록되었습니다" 같은 뻔한 표현 절대 사용 금지
- 누가 신청할 수 있는지, 어떤 혜택인지 임팩트 있게 표현

[공고명] ${item.title}
[사업개요] ${overview?.value || '공고명 참고'}
[지원대상] ${target?.value || '공고명 참고'}
[지원금액] ${amount?.value || '공고명 참고'}

예시 형식:
🎯 [지역/대상] 기업이라면 주목!
💰 [핵심 혜택 내용]
📌 지금 바로 신청하세요!`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (e) {
    return `📢 ${item.title}\n\n지원사업 공고가 등록되었습니다.\n자세한 내용을 확인하세요!`;
  }
}

// 카드뉴스 HTML → PNG 이미지 생성
async function generateCardImage(item, ment, outputPath, browser) {
  const colors = ['#2C5F8A', '#1B8A5A', '#8A4B2C', '#6B2C8A', '#8A2C5F'];
  const color = colors[Math.floor(Math.random() * colors.length)];

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1080px; height: 1080px;
    background: ${color};
    display: flex; flex-direction: column;
    justify-content: center; align-items: center;
    font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
    color: white; padding: 80px;
  }
  .tag {
    background: rgba(255,255,255,0.2);
    padding: 8px 20px; border-radius: 20px;
    font-size: 24px; margin-bottom: 40px;
    letter-spacing: 2px;
  }
  .title {
    font-size: 42px; font-weight: 700;
    text-align: center; line-height: 1.4;
    margin-bottom: 50px;
    word-break: keep-all;
  }
  .divider {
    width: 60px; height: 4px;
    background: rgba(255,255,255,0.6);
    margin-bottom: 50px;
  }
  .ment {
    font-size: 30px; text-align: center;
    line-height: 1.7; opacity: 0.9;
    word-break: keep-all;
  }
  .footer {
    position: absolute; bottom: 50px;
    font-size: 22px; opacity: 0.6;
  }
</style>
</head>
<body>
  <div class="tag">📋 지원사업 공고</div>
  <div class="title">${item.title.slice(0, 60)}${item.title.length > 60 ? '...' : ''}</div>
  <div class="ment">${ment.replace(/\n/g, '<br>')}</div>
  <div class="footer">정책캐처 · ${new Date().toLocaleDateString('ko-KR')}</div>
</body>
</html>`;

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.screenshot({
    path: outputPath,
    type: 'png',
    clip: { x: 0, y: 0, width: 1080, height: 1080 }
  });
  await page.close();
}

async function main() {
  log('=== 일일 자동 수집 + 메일 발송 시작 ===');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    // 1. 새 공고 수집
    const newItems = await getNewItems(page, 10);

    if (newItems.length === 0) {
      log('신규 공고 없음. 메일 발송 생략.');
      return;
    }

    log(`신규 공고 ${newItems.length}건 발견. 상세 수집 시작...`);

    // 2. 상세 정보 수집
    const results = [];
    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      log(`[${i + 1}/${newItems.length}] ${item.title}`);
      const detail = await scrapeDetail(page, item.url);
      if (detail) {
        detail.url = item.url;
        detail.listDate = item.date;
        results.push(detail);
      }
    }

    if (results.length === 0) { log('수집 결과 없음.'); return; }

    // 3. 출력 폴더 생성
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputDir = path.join(__dirname, 'output', `daily_${timestamp}`);
    fs.mkdirSync(outputDir, { recursive: true });

    // 4. 각 공고별 멘트 + 이미지 생성
    let emailBody = `📬 비즈인포 신규 지원사업 알림\n`;
    emailBody += `📅 ${new Date().toLocaleDateString('ko-KR')} 기준 ${results.length}건\n`;
    emailBody += `${'='.repeat(50)}\n\n`;

    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      log(`  멘트+이미지 생성: ${item.title}`);

      // Gemini RPM 한도 초과 방지 (넉넉하게 10초 딜레이)
      if (i > 0) await new Promise(r => setTimeout(r, 10000));

      // 멘트 생성
      const ment = await generateMent(item);

      // 이미지 생성
      const imgPath = path.join(outputDir, `card_${i + 1}_${sanitize(item.title).slice(0, 30)}.png`);
      try {
        await generateCardImage(item, ment, imgPath, browser);
        log(`  ✅ 이미지 생성: card_${i + 1}.png`);
      } catch (e) {
        log(`  ⚠️ 이미지 생성 실패: ${e.message}`);
      }

      // 멘트 txt 저장
      const mentPath = path.join(outputDir, `ment_${i + 1}_${sanitize(item.title).slice(0, 30)}.txt`);
      fs.writeFileSync(mentPath, `[${item.title}]\n\n${ment}\n\n🔗 ${item.url}`, 'utf8');

      // 이메일 본문에 추가
      emailBody += `【${i + 1}】 ${item.title}\n`;
      emailBody += `📅 등록일: ${item.regDate || item.listDate || '미상'}\n`;
      emailBody += `💬 멘트:\n${ment}\n`;
      emailBody += `🔗 ${item.url}\n`;
      emailBody += `${'-'.repeat(50)}\n\n`;
    }

    // 5. DB 업데이트
    const db = loadDB();
    results.forEach(item => {
      const id = extractId(item.url);
      if (id) db[id] = {
        title: item.title,
        collectedAt: new Date().toISOString(),
        regDate: item.regDate || item.listDate || ''
      };
    });
    saveDB(db);

    // 6. Gmail 전송
    log('📧 Gmail 전송 중...');
    await sendDailyReport({
      toEmail: TO_EMAIL,
      subject: `📋 비즈인포 신규 공고 ${results.length}건 - ${new Date().toLocaleDateString('ko-KR')}`,
      bodyText: emailBody,
      attachmentDir: outputDir,
    });

    log(`✅ 완료! 총 ${results.length}건 → ${TO_EMAIL} 으로 전송됨`);

  } catch (err) {
    log(`오류: ${err.message}`);
  } finally {
    await browser.close();
  }

  log('=== 일일 자동 수집 종료 ===\n');
}

main();
