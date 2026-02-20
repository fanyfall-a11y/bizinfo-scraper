require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { sendDailyReport } = require('./mailer');

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
  return name.replace(/[\/\\:*?"<>|\n\r]/g, '_').trim().slice(0, 60);
}

function extractRegion(title, details) {
  const regionMatch = title.match(/^\[([가-힣]+)\]/);
  if (regionMatch) return regionMatch[1];
  if (details && details.length > 0) {
    const jza = details.find(d => d.label && (d.label.includes('지자체') || d.label.includes('소관부처')));
    if (jza) {
      const regions = ['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주'];
      for (const r of regions) {
        if (jza.value && jza.value.includes(r)) return r;
      }
    }
  }
  return '전국';
}

// 새 공고 목록 수집
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

// 상세 페이지 스크래핑 (사업목적, 신청자격, 지원내용, 모집구분 포함)
async function scrapeDetail(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    return await page.evaluate(() => {
      // 제목
      let title = '';
      for (const h of document.querySelectorAll('h2, h3, h4')) {
        const t = h.innerText.trim();
        if (t.length > title.length && t.length > 5 &&
          !['정책정보','지원사업 공고','활용정보','고객알림','이용안내'].includes(t)) title = t;
      }

      // 기본 정보 (라벨-값 쌍)
      const details = [];
      document.querySelectorAll('li').forEach(li => {
        const label = li.querySelector('.s_title')?.innerText.trim();
        const value = li.querySelector('.txt')?.innerText.replace(/\s+/g, ' ').trim();
        if (label && value) details.push({ label, value });
      });

      // 사업개요에서 핵심 정보 추출
      const overview = details.find(d => d.label.includes('사업개요'));
      const target = details.find(d => d.label.includes('지원대상') || d.label.includes('신청자격'));
      const amount = details.find(d => d.label.includes('지원금액') || d.label.includes('지원규모') || d.label.includes('지원내용'));
      const method = details.find(d => d.label.includes('신청방법') || d.label.includes('사업신청'));
      const period = details.find(d => d.label.includes('신청기간') || d.label.includes('접수기간'));
      const contact = details.find(d => d.label.includes('문의처') || d.label.includes('담당'));
      const organ = details.find(d => d.label.includes('주관') || d.label.includes('소관부처') || d.label.includes('지자체'));

      // 본문 전체 텍스트에서 섹션별 추출
      const bodyText = document.body.innerText;

      // 마감일 추출
      const deadlineMatch = bodyText.match(/(?:신청기간|접수기간|마감)[^\n]*?(\d{4}[.\-년]\s*\d{1,2}[.\-월]\s*\d{1,2})/);
      const deadline = deadlineMatch ? deadlineMatch[1].replace(/\s/g, '').replace(/년|월/g, '.').replace(/일/g, '') : '';

      // 등록일
      const dateEl = document.querySelector('.date, .reg_date, .write_date');
      const regDate = dateEl?.innerText?.replace(/[^0-9\.\-]/g, '').trim() || '';

      return {
        title,
        details,
        overview: overview?.value || '',
        target: target?.value || '',
        amount: amount?.value || '',
        method: method?.value || '',
        period: period?.value || '',
        contact: contact?.value || '',
        organ: organ?.value || '',
        deadline,
        regDate
      };
    });
  } catch {
    log(`접속 실패: ${url}`);
    return null;
  }
}

// Gemini로 핵심 멘트 생성
async function generateMent(item) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const prompt = `다음 지원사업 공고를 SNS 카드뉴스 썸네일용 한 줄 핵심 문구로 작성해줘.
- 반드시 1~2줄
- 이모지 1~2개 포함
- "지원사업 공고가 등록되었습니다" 같은 뻔한 표현 절대 금지
- 누가 받을 수 있는지, 얼마나 받는지 핵심만 임팩트 있게
- 예: "💰 울산 중소기업이라면! 경영안정자금 최대 5천만원 지원"

[공고명] ${item.title}
[사업개요] ${item.overview || '공고명 참고'}
[지원대상] ${item.target || '공고명 참고'}
[지원금액] ${item.amount || '공고명 참고'}`;

    const result = await model.generateContent(prompt);
    return result.response.text().trim();
  } catch (e) {
    return `📢 ${item.title.slice(0, 40)}`;
  }
}

// 카드 1: 썸네일
function makeCard1Html(item, ment) {
  const region = extractRegion(item.title, item.details);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1080px; height:1350px;
  background: linear-gradient(160deg, #1a4fa0 0%, #2563c7 50%, #1e3a7a 100%);
  display:flex; flex-direction:column;
  font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;
  color:white; position:relative; overflow:hidden;
}
.top-bar {
  background:rgba(255,255,255,0.15);
  padding:24px 60px;
  font-size:26px; font-weight:600; letter-spacing:2px;
  display:flex; align-items:center; gap:12px;
}
.main {
  flex:1; display:flex; flex-direction:column;
  justify-content:center; align-items:center;
  padding:60px;
}
.region-tag {
  background:rgba(255,255,255,0.2);
  border:2px solid rgba(255,255,255,0.4);
  padding:10px 28px; border-radius:30px;
  font-size:28px; margin-bottom:50px; letter-spacing:1px;
}
.title {
  font-size:52px; font-weight:800;
  text-align:center; line-height:1.4;
  margin-bottom:50px; word-break:keep-all;
  text-shadow: 0 2px 8px rgba(0,0,0,0.2);
}
.ment {
  background:rgba(255,255,255,0.15);
  border-left:6px solid rgba(255,255,255,0.8);
  padding:24px 36px; border-radius:12px;
  font-size:32px; line-height:1.6;
  text-align:center; word-break:keep-all;
  margin-bottom:50px;
}
.deadline {
  background:rgba(255,200,0,0.25);
  border:2px solid rgba(255,200,0,0.6);
  padding:14px 36px; border-radius:30px;
  font-size:30px; font-weight:700;
}
.footer {
  background:rgba(0,0,0,0.2);
  padding:24px 60px;
  display:flex; justify-content:space-between; align-items:center;
  font-size:24px; opacity:0.8;
}
.deco-circle {
  position:absolute; border-radius:50%;
  background:rgba(255,255,255,0.05);
}
</style></head>
<body>
  <div class="deco-circle" style="width:400px;height:400px;top:-100px;right:-100px;"></div>
  <div class="deco-circle" style="width:300px;height:300px;bottom:150px;left:-80px;"></div>
  <div class="top-bar">💡 대표님들을 위한 BIZ-TIP</div>
  <div class="main">
    <div class="region-tag">📍 ${region}</div>
    <div class="title">${item.title.replace(/^\[[가-힣]+\]\s*/, '').slice(0, 50)}${item.title.replace(/^\[[가-힣]+\]\s*/, '').length > 50 ? '...' : ''}</div>
    <div class="ment">${ment}</div>
    ${item.deadline ? `<div class="deadline">⏰ 마감 ${item.deadline}</div>` : ''}
  </div>
  <div class="footer">
    <span>🔷 정책캐처</span>
    <span>${new Date().toLocaleDateString('ko-KR')}</span>
  </div>
</body></html>`;
}

// 카드 2: 사업목적 + 신청자격
function makeCard2Html(item) {
  const overviewLines = (item.overview || '내용을 확인해주세요.').slice(0, 200);
  const targetLines = (item.target || '공고 원문을 확인해주세요.').slice(0, 200);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1080px; height:1350px;
  background:#f0f5ff;
  display:flex; flex-direction:column;
  font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;
  position:relative; overflow:hidden;
}
.top-bar {
  background:linear-gradient(90deg,#1a4fa0,#2563c7);
  padding:24px 60px; color:white;
  font-size:26px; font-weight:600; letter-spacing:2px;
  display:flex; align-items:center; gap:12px;
}
.card-inner {
  flex:1; background:white;
  margin:30px 40px; border-radius:24px;
  padding:50px; display:flex; flex-direction:column; gap:40px;
  box-shadow:0 8px 32px rgba(37,99,199,0.1);
}
.section-tag {
  display:inline-block;
  background:#2563c7; color:white;
  padding:10px 24px; border-radius:20px;
  font-size:26px; font-weight:700; margin-bottom:20px;
}
.section-content {
  font-size:28px; line-height:1.8; color:#333;
  word-break:keep-all;
}
.divider {
  height:2px; background:#e8f0fe; border-radius:2px;
}
.footer {
  background:linear-gradient(90deg,#1a4fa0,#2563c7);
  padding:20px 60px; color:white;
  display:flex; justify-content:space-between;
  font-size:22px; opacity:0.9;
}
</style></head>
<body>
  <div class="top-bar">💡 대표님들을 위한 BIZ-TIP</div>
  <div class="card-inner">
    <div>
      <div class="section-tag">사업목적</div>
      <div class="section-content">${overviewLines}</div>
    </div>
    <div class="divider"></div>
    <div>
      <div class="section-tag">신청자격</div>
      <div class="section-content">${targetLines}</div>
    </div>
  </div>
  <div class="footer">
    <span>🔷 정책캐처</span>
    <span>${new Date().toLocaleDateString('ko-KR')}</span>
  </div>
</body></html>`;
}

// 카드 3: 지원내용
function makeCard3Html(item) {
  const amountText = (item.amount || '공고 원문을 확인해주세요.').slice(0, 300);
  const methodText = (item.method || '').slice(0, 150);
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1080px; height:1350px;
  background:#f0f5ff;
  display:flex; flex-direction:column;
  font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;
}
.top-bar {
  background:linear-gradient(90deg,#1a4fa0,#2563c7);
  padding:24px 60px; color:white;
  font-size:26px; font-weight:600; letter-spacing:2px;
}
.card-inner {
  flex:1; background:white;
  margin:30px 40px; border-radius:24px;
  padding:50px; display:flex; flex-direction:column; gap:30px;
  box-shadow:0 8px 32px rgba(37,99,199,0.1);
}
.section-tag {
  display:inline-block;
  background:#2563c7; color:white;
  padding:10px 24px; border-radius:20px;
  font-size:26px; font-weight:700; margin-bottom:20px;
}
.amount-box {
  background:#e8f0fe; border-radius:16px;
  padding:30px; font-size:28px; line-height:1.8; color:#1a3a7a;
  word-break:keep-all;
}
.method-box {
  background:#f8faff; border:2px solid #d0e0ff;
  border-radius:16px; padding:24px;
  font-size:26px; line-height:1.7; color:#333;
}
.footer {
  background:linear-gradient(90deg,#1a4fa0,#2563c7);
  padding:20px 60px; color:white;
  display:flex; justify-content:space-between;
  font-size:22px;
}
</style></head>
<body>
  <div class="top-bar">💡 대표님들을 위한 BIZ-TIP</div>
  <div class="card-inner">
    <div>
      <div class="section-tag">지원내용</div>
      <div class="amount-box">${amountText}</div>
    </div>
    ${methodText ? `<div>
      <div class="section-tag">신청방법</div>
      <div class="method-box">${methodText}</div>
    </div>` : ''}
  </div>
  <div class="footer">
    <span>🔷 정책캐처</span>
    <span>${new Date().toLocaleDateString('ko-KR')}</span>
  </div>
</body></html>`;
}

// 카드 4: 신청정보 + 링크
function makeCard4Html(item, url) {
  const periodText = item.period || item.deadline || '공고 원문 확인';
  const contactText = item.contact || '공고 원문 확인';
  const organText = item.organ || '';
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1080px; height:1350px;
  background:linear-gradient(160deg,#1a4fa0 0%,#2563c7 50%,#1e3a7a 100%);
  display:flex; flex-direction:column;
  font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;
  color:white;
}
.top-bar {
  background:rgba(255,255,255,0.15);
  padding:24px 60px;
  font-size:26px; font-weight:600; letter-spacing:2px;
}
.main {
  flex:1; display:flex; flex-direction:column;
  justify-content:center; padding:60px; gap:30px;
}
.info-row {
  background:rgba(255,255,255,0.12);
  border-radius:16px; padding:28px 36px;
  display:flex; flex-direction:column; gap:10px;
}
.info-label {
  font-size:24px; opacity:0.7; font-weight:600;
}
.info-value {
  font-size:30px; font-weight:700; word-break:keep-all;
}
.cta {
  background:rgba(255,255,255,0.2);
  border:2px solid rgba(255,255,255,0.5);
  border-radius:16px; padding:28px 36px;
  text-align:center; font-size:32px; font-weight:800;
  margin-top:10px;
}
.footer {
  background:rgba(0,0,0,0.2);
  padding:24px 60px;
  display:flex; justify-content:space-between;
  font-size:22px; opacity:0.8;
}
</style></head>
<body>
  <div class="top-bar">💡 대표님들을 위한 BIZ-TIP</div>
  <div class="main">
    <div class="info-row">
      <div class="info-label">📅 신청기간</div>
      <div class="info-value">${periodText}</div>
    </div>
    ${organText ? `<div class="info-row">
      <div class="info-label">🏛️ 주관기관</div>
      <div class="info-value">${organText}</div>
    </div>` : ''}
    <div class="info-row">
      <div class="info-label">📞 문의처</div>
      <div class="info-value">${contactText}</div>
    </div>
    <div class="cta">🔗 지금 바로 신청하세요!</div>
  </div>
  <div class="footer">
    <span>🔷 정책캐처</span>
    <span>${new Date().toLocaleDateString('ko-KR')}</span>
  </div>
</body></html>`;
}

// HTML → PNG 변환
async function htmlToImage(html, outputPath, browser) {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.screenshot({
    path: outputPath,
    type: 'png',
    clip: { x: 0, y: 0, width: 1080, height: 1350 }
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

    // 3. 지역별 폴더 구조 생성
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseDir = path.join(__dirname, 'output', `daily_${timestamp}`);
    fs.mkdirSync(baseDir, { recursive: true });

    let emailBody = `📬 정책캐처 신규 지원사업 알림\n`;
    emailBody += `📅 ${new Date().toLocaleDateString('ko-KR')} 기준 ${results.length}건\n`;
    emailBody += `${'='.repeat(50)}\n\n`;

    const allAttachments = [];

    // 4. 각 공고별 처리
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const region = extractRegion(item.title, item.details);
      const itemDirName = sanitize(item.title.replace(/^\[[가-힣]+\]\s*/, ''));

      // 지역별 > 사업명별 폴더
      const itemDir = path.join(baseDir, region, itemDirName);
      fs.mkdirSync(itemDir, { recursive: true });

      log(`  [${i + 1}/${results.length}] ${region} / ${item.title}`);

      // Gemini 딜레이 (10초)
      if (i > 0) await new Promise(r => setTimeout(r, 10000));

      // 멘트 생성
      const ment = await generateMent(item);

      // 카드 4장 생성
      try {
        await htmlToImage(makeCard1Html(item, ment), path.join(itemDir, '01_썸네일.png'), browser);
        await htmlToImage(makeCard2Html(item), path.join(itemDir, '02_사업목적_신청자격.png'), browser);
        await htmlToImage(makeCard3Html(item), path.join(itemDir, '03_지원내용.png'), browser);
        await htmlToImage(makeCard4Html(item, item.url), path.join(itemDir, '04_신청정보.png'), browser);
        log(`    ✅ 카드 4장 생성 완료`);

        // 첨부파일 목록에 추가
        ['01_썸네일.png','02_사업목적_신청자격.png','03_지원내용.png','04_신청정보.png'].forEach(f => {
          allAttachments.push({ filename: `[${region}] ${itemDirName}_${f}`, path: path.join(itemDir, f) });
        });
      } catch (e) {
        log(`    ⚠️ 이미지 생성 실패: ${e.message}`);
      }

      // 멘트 txt 저장
      const mentContent = `[${item.title}]\n\n📌 핵심 멘트:\n${ment}\n\n📋 사업개요:\n${item.overview || '없음'}\n\n👥 지원대상:\n${item.target || '없음'}\n\n💰 지원내용:\n${item.amount || '없음'}\n\n📅 신청기간:\n${item.period || item.deadline || '없음'}\n\n📞 문의:\n${item.contact || '없음'}\n\n🔗 링크:\n${item.url}`;
      fs.writeFileSync(path.join(itemDir, '멘트_요약.txt'), mentContent, 'utf8');

      // 이메일 본문
      emailBody += `【${i + 1}】 [${region}] ${item.title}\n`;
      emailBody += `💬 ${ment}\n`;
      emailBody += `📅 ${item.period || item.deadline || '미상'}\n`;
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
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: `"정책캐처 자동수집" <${process.env.GMAIL_USER}>`,
      to: TO_EMAIL,
      subject: `📋 정책캐처 신규 공고 ${results.length}건 - ${new Date().toLocaleDateString('ko-KR')}`,
      text: emailBody,
      attachments: allAttachments.slice(0, 20),
    });

    log(`✅ 완료! 총 ${results.length}건 → ${TO_EMAIL} 전송됨`);
    log(`📁 저장위치: ${baseDir}`);

  } catch (err) {
    log(`오류: ${err.message}`);
  } finally {
    await browser.close();
  }

  log('=== 일일 자동 수집 종료 ===\n');
}

main();
