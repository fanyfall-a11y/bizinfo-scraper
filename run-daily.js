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
  return name
    .replace(/[\/\\:*?"<>|\n\r+()（）【】\[\]「」『』〔〕·•]/g, '_')
    .replace(/_+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
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

// Gemini로 멘트 + 신청자격 + 지원내용 + 블로그 3종 생성
async function generateMent(item) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

    const overview = item.overview || '';
    const title = item.title;
    const period = item.period || item.deadline || '미상';
    const contact = item.contact || '공고 원문 확인';

    const prompt = `다음 지원사업 공고를 분석해서 아래 형식으로 정리해줘. 반드시 구분자(---)를 정확히 사용해.

[공고명] ${title}
[사업개요] ${overview.slice(0, 800)}
[신청기간] ${period}
[문의처] ${contact}

===출력형식 시작===

---썸네일멘트---
(SNS 카드뉴스용. 1~2줄. 이모지 1~2개. 누가/얼마/어떤혜택인지 핵심만. "지원사업 공고가 등록되었습니다" 같은 뻔한 표현 절대 금지)

---신청자격---
(신청 가능한 대상 조건만. 불릿포인트(•)로 3~5줄. 정보 없으면 "공고 원문을 확인해주세요.")

---지원내용---
(지원금액, 지원내용만. 불릿포인트(•)로 3~5줄. 정보 없으면 "공고 원문을 확인해주세요.")

---네이버블로그---
[작성 지침]
- 1500~2000자
- 친근하지만 전문적인 경어체
- 검색 상위노출용 키워드 자연스럽게 포함
- 소제목(##) 사용
- 마지막에 "공감과 댓글은 큰 힘이 됩니다 😊" 추가
- 복사 붙여넣기 바로 가능하게 완성형으로 작성
- AI 말투 절대 금지: "안녕하세요!", "오늘은 ~에 대해 알아보겠습니다", "~하시면 됩니다!" 같은 표현 사용 금지
- 실제 블로거가 직접 쓴 것처럼 자연스럽게
- 키워드: ${title.replace(/\[[가-힣]+\]/g, '').trim().split(' ').slice(0, 3).join(', ')}
제목:
본문:

---티스토리---
[작성 지침]
- 1000~1500자
- 정보성 경어체, 담백하고 군더더기 없는 문장
- SEO 최적화, 소제목(##) 사용
- 핵심정보 위주로 간결하게
- AI 말투 절대 금지: 과도한 이모지, 감탄사, 정형화된 인사말 사용 금지
- 실제 전문 블로거가 쓴 것처럼 자연스럽게
- 복사 붙여넣기 바로 가능하게 완성형으로 작성
제목:
본문:

---블로그스팟---
[작성 지침]
- 800~1200자
- 간결하고 핵심만 담은 경어체
- 핵심정보만 단락 구분
- 해시태그 5개 포함
- AI 말투 절대 금지: 뻔한 도입부, 과도한 이모지 사용 금지
- 자연스럽고 담백하게
- 복사 붙여넣기 바로 가능하게 완성형으로 작성
제목:
본문:`;

    const result = await model.generateContent(prompt);
    const firstDraft = result.response.text().trim();

    // 1차 검수: 생성된 블로그 글에서 문제점 체크 후 보정
    await new Promise(r => setTimeout(r, 20000)); // 검수 전 20초 딜레이

    const reviewPrompt = `다음은 지원사업 공고를 기반으로 작성된 블로그 글 초안입니다.
아래 검수 기준에 맞게 문제가 있는 부분만 수정해서 최종본을 출력해줘.

[검수 기준]
1. AI 말투 제거: "안녕하세요!", "오늘은 ~에 대해 알아보겠습니다", "~하시면 됩니다!" 등 → 자연스러운 문장으로 교체
2. 할루시네이션 방지: 공고 원문에 없는 수치나 정보가 추가되어 있으면 삭제하고 "공고 원문을 확인해주세요"로 대체
3. 중복 콘텐츠 방지: 네이버/티스토리/블로그스팟 글이 너무 비슷하면 도입부와 마무리 문장을 다르게 수정
4. 공고명, 신청기간, 지원내용은 원문 그대로 유지 (변경 금지)

[공고 원문 핵심]
공고명: ${title}
신청기간: ${period}
사업개요: ${overview.slice(0, 400)}

[초안]
${firstDraft}

===검수 후 최종 출력 (초안과 동일한 구분자 형식 유지)===`;

    const reviewResult = await model.generateContent(reviewPrompt);
    const text = reviewResult.response.text().trim();

    // 파싱
    const mentMatch = text.match(/---썸네일멘트---([\s\S]*?)---신청자격---/);
    const targetMatch = text.match(/---신청자격---([\s\S]*?)---지원내용---/);
    const amountMatch = text.match(/---지원내용---([\s\S]*?)---네이버블로그---/);
    const naverMatch = text.match(/---네이버블로그---([\s\S]*?)---티스토리---/);
    const tistoryMatch = text.match(/---티스토리---([\s\S]*?)---블로그스팟---/);
    const blogspotMatch = text.match(/---블로그스팟---([\s\S]*?)$/);

    return {
      ment: mentMatch ? mentMatch[1].trim() : `📢 ${item.title.slice(0, 40)}`,
      target: targetMatch ? targetMatch[1].trim() : '공고 원문을 확인해주세요.',
      amount: amountMatch ? amountMatch[1].trim() : item.amount || '공고 원문을 확인해주세요.',
      naver: naverMatch ? naverMatch[1].trim() : '네이버 블로그 글 생성 실패. 공고 원문을 확인해주세요.',
      tistory: tistoryMatch ? tistoryMatch[1].trim() : '티스토리 글 생성 실패. 공고 원문을 확인해주세요.',
      blogspot: blogspotMatch ? blogspotMatch[1].trim() : '블로그스팟 글 생성 실패. 공고 원문을 확인해주세요.',
    };
  } catch (e) {
    log(`Gemini 오류: ${e.message}`);
    return {
      ment: `📢 ${item.title.slice(0, 40)}`,
      target: item.target || '공고 원문을 확인해주세요.',
      amount: item.amount || '공고 원문을 확인해주세요.',
      naver: '네이버 블로그 글 생성 실패.',
      tistory: '티스토리 글 생성 실패.',
      blogspot: '블로그스팟 글 생성 실패.',
    };
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
  const targetLines = (item.aiTarget || item.target || '공고 원문을 확인해주세요.').slice(0, 300);
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
  const amountText = (item.aiAmount || item.amount || '공고 원문을 확인해주세요.').slice(0, 300);
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
    const newItems = await getNewItems(page, 1); // 테스트: 1페이지만

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

      // Gemini 딜레이 (공고 사이 10초 + 검수 내부 20초 = 공고당 총 ~30초)
      if (i > 0) await new Promise(r => setTimeout(r, 10000));

      // Gemini로 멘트 + 신청자격 + 지원내용 추출
      const geminiResult = await generateMent(item);

      // Gemini 결과를 item에 반영
      item.aiMent = geminiResult.ment;
      item.aiTarget = geminiResult.target;
      item.aiAmount = geminiResult.amount;
      item.aiNaver = geminiResult.naver;
      item.aiTistory = geminiResult.tistory;
      item.aiBlogspot = geminiResult.blogspot;

      // 카드 4장 생성
      try {
        await htmlToImage(makeCard1Html(item, item.aiMent), path.join(itemDir, '01_썸네일.png'), browser);
        await htmlToImage(makeCard2Html(item), path.join(itemDir, '02_사업목적_신청자격.png'), browser);
        await htmlToImage(makeCard3Html(item), path.join(itemDir, '03_지원내용.png'), browser);
        await htmlToImage(makeCard4Html(item, item.url), path.join(itemDir, '04_신청정보.png'), browser);
        log(`    ✅ 카드 4장 생성 완료`);

        ['01_썸네일.png','02_사업목적_신청자격.png','03_지원내용.png','04_신청정보.png'].forEach(f => {
          allAttachments.push({ filename: `[${region}] ${itemDirName}_${f}`, path: path.join(itemDir, f) });
        });
      } catch (e) {
        log(`    ⚠️ 이미지 생성 실패: ${e.message}`);
      }

      // 멘트 + 요약 저장
      const mentContent = `[${item.title}]\n\n📌 핵심 멘트 (카드뉴스용):\n${item.aiMent}\n\n👥 신청자격:\n${item.aiTarget}\n\n💰 지원내용:\n${item.aiAmount}\n\n📅 신청기간:\n${item.period || item.deadline || '없음'}\n\n📞 문의:\n${item.contact || '없음'}\n\n🔗 링크:\n${item.url}`;
      fs.writeFileSync(path.join(itemDir, '00_멘트_요약.txt'), mentContent, 'utf8');

      // 플랫폼별 블로그 글 저장
      fs.writeFileSync(path.join(itemDir, '05_네이버블로그.txt'), item.aiNaver, 'utf8');
      fs.writeFileSync(path.join(itemDir, '06_티스토리.txt'), item.aiTistory, 'utf8');
      fs.writeFileSync(path.join(itemDir, '07_블로그스팟.txt'), item.aiBlogspot, 'utf8');

      // 이메일 본문
      emailBody += `【${i + 1}】 [${region}] ${item.title}\n`;
      emailBody += `💬 ${item.aiMent}\n`;
      emailBody += `👥 ${item.aiTarget.slice(0, 100)}\n`;
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
