require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const LIST_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do?schPblancDiv=01';
const DB_FILE = path.join(__dirname, 'collected_ids.json');
const TODAY_LIST_FILE = path.join(__dirname, 'docs', 'today-list.json');
const DAILY_DIR = path.join(__dirname, 'docs', 'daily');

function log(msg) {
  const line = `[${new Date().toLocaleString('ko-KR')}] ${msg}`;
  console.log(line);
}

function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
  }
  return {};
}

function extractId(url) {
  const match = url.match(/pblancId=([A-Z0-9_]+)/);
  return match ? match[1] : null;
}

function extractRegion(title) {
  const regionMatch = title.match(/^\[([가-힣]+)\]/);
  return regionMatch ? regionMatch[1] : '전국';
}

// 타겟 독자 대상 공고 여부 판별
function isTargetAudience(title) {
  const keywords = [
    '청년', '청년창업', '청년사업자', '청년기업',
    '소상공인', '소기업', '영세', '자영업',
    '1인', '1인사업자', '1인기업', '프리랜서', '1인창업',
    '예비창업', '초기창업', '예비창업자', '초기창업자',
    '창업준비', '창업예정',
    '3년 미만', '3년미만', '5년 미만', '5년미만',
    '7년 미만', '7년미만', '10년 미만', '10년미만',
    '창업 3년', '창업3년', '창업 5년', '창업5년',
    '창업 7년', '창업7년',
    '스타트업', '벤처', '창업기업', '신생기업',
    '중소기업', '소규모', '소형',
    '창업자', '창업지원', '창업육성', '창업생태계',
  ];
  return keywords.some(kw => title.includes(kw));
}

// 분야 분류
function getCategory(title) {
  if (title.includes('교육') || title.includes('강좌') || title.includes('아카데미') ||
      title.includes('연수') || title.includes('훈련') || title.includes('강의') ||
      title.includes('부트캠프') || title.includes('캠프')) return '창업교육';

  if (title.includes('멘토') || title.includes('컨설팅') || title.includes('코칭') ||
      title.includes('자문') || title.includes('진단') || title.includes('상담')) return '컨설팅/멘토링';

  if (title.includes('글로벌') || title.includes('해외') || title.includes('수출') ||
      title.includes('국제') || title.includes('외국') || title.includes('해외진출') ||
      title.includes('무역')) return '글로벌';

  if (title.includes('공간') || title.includes('시설') || title.includes('입주') ||
      title.includes('사무실') || title.includes('센터') || title.includes('거점') ||
      title.includes('공유오피스') || title.includes('lab') || title.includes('LAB')) return '시설제공';

  if (title.includes('투자') || title.includes('융자') || title.includes('대출') ||
      title.includes('보증') || title.includes('펀드') || title.includes('금융') ||
      title.includes('자금') || title.includes('지원금') || title.includes('보조금') ||
      title.includes('R&D') || title.includes('연구개발')) return '자금지원';

  if (title.includes('판로') || title.includes('마케팅') || title.includes('홍보') ||
      title.includes('전시') || title.includes('박람회') || title.includes('판매') ||
      title.includes('유통') || title.includes('온라인판매')) return '판로/마케팅';

  return '사업화';
}

// 지역 분류
function getRegionCategory(title) {
  if (title.includes('서울')) return '서울';
  if (title.includes('경기') || title.includes('수원') || title.includes('성남') ||
      title.includes('고양') || title.includes('용인') || title.includes('안양') ||
      title.includes('부천') || title.includes('의정부')) return '경기';
  if (title.includes('인천')) return '인천';
  if (title.includes('부산')) return '부산';
  if (title.includes('대구')) return '대구';
  if (title.includes('대전')) return '대전';
  if (title.includes('광주')) return '광주';
  if (title.includes('울산')) return '울산';
  if (title.includes('세종')) return '세종';
  if (title.includes('강원') || title.includes('춘천') || title.includes('원주')) return '강원';
  if (title.includes('충북') || title.includes('청주') || title.includes('충청북')) return '충북';
  if (title.includes('충남') || title.includes('천안') || title.includes('충청남') ||
      title.includes('아산')) return '충남';
  if (title.includes('전북') || title.includes('전주') || title.includes('전라북')) return '전북';
  if (title.includes('전남') || title.includes('목포') || title.includes('전라남') ||
      title.includes('여수') || title.includes('순천')) return '전남';
  if (title.includes('경북') || title.includes('포항') || title.includes('경상북') ||
      title.includes('구미') || title.includes('안동')) return '경북';
  if (title.includes('경남') || title.includes('창원') || title.includes('경상남') ||
      title.includes('진주') || title.includes('김해')) return '경남';
  if (title.includes('제주')) return '제주';
  return '전국';
}

// 8일 이전 daily 파일 삭제
function cleanOldDailyFiles() {
  if (!fs.existsSync(DAILY_DIR)) return;
  const files = fs.readdirSync(DAILY_DIR).filter(f => f.endsWith('.json'));
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 7);

  files.forEach(file => {
    const dateStr = file.replace('.json', '');
    const fileDate = new Date(dateStr);
    if (!isNaN(fileDate) && fileDate < cutoff) {
      fs.unlinkSync(path.join(DAILY_DIR, file));
      log(`🗑️ 오래된 파일 삭제: ${file}`);
    }
  });
}

async function collectList(page, maxPages = 15) {
  const db = loadDB();
  const newItems = [];
  let currentPage = 1;
  let hitExisting = false;

  while (currentPage <= maxPages) {
    const url = currentPage === 1 ? LIST_URL : `${LIST_URL}&cpage=${currentPage}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

async function main() {
  log('=== 공고 목록 수집 시작 ===');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    const newItems = await collectList(page, 15);
    log(`총 ${newItems.length}건 신규 공고 수집 완료`);

    const today = new Date().toISOString().slice(0, 10);

    // 목록에 분야/지역/타겟 정보 추가
    const itemsWithMeta = newItems.map((item, idx) => ({
      idx: idx + 1,
      title: item.title,
      url: item.url,
      date: item.date,
      region: extractRegion(item.title),          // 공고 제목의 [지역] 태그
      regionCategory: getRegionCategory(item.title), // 지역 분류
      category: getCategory(item.title),           // 분야 분류
      cleanTitle: item.title.replace(/^\[[가-힣]+\]\s*/, ''),
      isTarget: isTargetAudience(item.title),
    }));

    const targetItems = itemsWithMeta.filter(i => i.isTarget);
    const otherItems = itemsWithMeta.filter(i => !i.isTarget);
    log(`🎯 타겟 공고: ${targetItems.length}건 / 기타: ${otherItems.length}건`);

    const saveData = {
      date: today,
      total: itemsWithMeta.length,
      targetCount: targetItems.length,
      items: itemsWithMeta
    };

    // docs/today-list.json 저장 (기존 호환)
    fs.mkdirSync(path.dirname(TODAY_LIST_FILE), { recursive: true });
    fs.writeFileSync(TODAY_LIST_FILE, JSON.stringify(saveData, null, 2), 'utf8');
    log(`✅ today-list.json 저장 완료`);

    // docs/daily/날짜.json 저장 (7일치 보관)
    fs.mkdirSync(DAILY_DIR, { recursive: true });
    const dailyFile = path.join(DAILY_DIR, `${today}.json`);
    fs.writeFileSync(dailyFile, JSON.stringify(saveData, null, 2), 'utf8');
    log(`✅ daily/${today}.json 저장 완료`);

    // 8일 이전 파일 삭제
    cleanOldDailyFiles();

    // collected_ids.json 업데이트
    const db = loadDB();
    itemsWithMeta.forEach(item => {
      const id = extractId(item.url);
      if (id) db[id] = today;
    });
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');

    if (newItems.length === 0) {
      log('신규 공고 없음.');
      return;
    }

    // 이메일 발송
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    const TO_EMAIL = process.env.TO_EMAIL || 'nagairams1@gmail.com';
    const pageUrl = 'https://fanyfall-a11y.github.io/bizinfo-scraper/';

    let emailBody = `📋 오늘 신규 지원사업 공고 ${newItems.length}건 수집 완료!\n`;
    emailBody += `🎯 타겟 공고 ${targetItems.length}건 / 기타 ${otherItems.length}건\n\n`;
    emailBody += `👉 공고 선택 페이지:\n${pageUrl}\n\n`;
    emailBody += `${'='.repeat(50)}\n\n`;

    if (targetItems.length > 0) {
      emailBody += `🎯 ★ 추천 공고 (청년·소상공인·창업자 대상) ${targetItems.length}건\n`;
      emailBody += `${'='.repeat(50)}\n\n`;
      targetItems.forEach(item => {
        emailBody += `⭐【${item.idx}】 [${item.regionCategory}] [${item.category}] ${item.cleanTitle}\n`;
        emailBody += `📅 ${item.date}\n`;
        emailBody += `🔗 ${item.url}\n`;
        emailBody += `${'-'.repeat(40)}\n\n`;
      });
    }

    if (otherItems.length > 0) {
      emailBody += `📁 기타 공고 ${otherItems.length}건\n`;
      emailBody += `${'='.repeat(50)}\n\n`;
      otherItems.forEach(item => {
        emailBody += `【${item.idx}】 [${item.regionCategory}] [${item.category}] ${item.cleanTitle}\n`;
        emailBody += `📅 ${item.date}\n`;
        emailBody += `🔗 ${item.url}\n`;
        emailBody += `${'-'.repeat(40)}\n\n`;
      });
    }

    await transporter.sendMail({
      from: `"나혼자창업 자동수집" <${process.env.GMAIL_USER}>`,
      to: TO_EMAIL,
      subject: `🎯 추천 ${targetItems.length}건 포함 오늘 신규 공고 ${newItems.length}건 (${new Date().toLocaleDateString('ko-KR')})`,
      text: emailBody,
    });

    log(`📧 목록 이메일 발송 완료 → ${TO_EMAIL}`);

  } catch (err) {
    log(`오류: ${err.message}`);
    console.error(err);
  } finally {
    await browser.close();
  }

  log('=== 공고 목록 수집 종료 ===');
}

main();
