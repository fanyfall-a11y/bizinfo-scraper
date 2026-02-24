require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const LIST_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do?schPblancDiv=01';
const DB_FILE = path.join(__dirname, 'collected_ids.json');
const TODAY_LIST_FILE = path.join(__dirname, 'docs', 'today-list.json');

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
    // 청년 관련
    '청년', '청년창업', '청년사업자', '청년기업',
    // 소상공인 관련
    '소상공인', '소기업', '영세', '자영업',
    // 1인 관련
    '1인', '1인사업자', '1인기업', '프리랜서', '1인창업',
    // 예비/초기창업자
    '예비창업', '초기창업', '예비창업자', '초기창업자',
    '창업준비', '창업예정',
    // 창업 연차
    '3년 미만', '3년미만', '5년 미만', '5년미만',
    '7년 미만', '7년미만', '10년 미만', '10년미만',
    '창업 3년', '창업3년', '창업 5년', '창업5년',
    '창업 7년', '창업7년',
    // 스타트업/벤처
    '스타트업', '벤처', '창업기업', '신생기업',
    // 중소/소규모
    '중소기업', '소규모', '소형',
    // 일반 창업
    '창업자', '창업지원', '창업육성', '창업생태계',
  ];
  return keywords.some(kw => title.includes(kw));
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

    if (newItems.length === 0) {
      log('신규 공고 없음.');
      // 빈 목록 저장
      fs.mkdirSync(path.dirname(TODAY_LIST_FILE), { recursive: true });
      fs.writeFileSync(TODAY_LIST_FILE, JSON.stringify({
        date: new Date().toISOString().slice(0, 10),
        items: []
      }, null, 2), 'utf8');
      return;
    }

    // 목록에 지역 정보 + 타겟 여부 추가
    const itemsWithRegion = newItems.map((item, idx) => ({
      idx: idx + 1,
      title: item.title,
      url: item.url,
      date: item.date,
      region: extractRegion(item.title),
      cleanTitle: item.title.replace(/^\[[가-힣]+\]\s*/, ''),
      isTarget: isTargetAudience(item.title), // 타겟 독자 대상 여부
    }));

    const targetItems = itemsWithRegion.filter(i => i.isTarget);
    const otherItems = itemsWithRegion.filter(i => !i.isTarget);
    log(`🎯 타겟 공고: ${targetItems.length}건 / 기타: ${otherItems.length}건`);

    // docs/today-list.json 저장 (웹페이지에서 읽을 파일)
    fs.mkdirSync(path.dirname(TODAY_LIST_FILE), { recursive: true });
    fs.writeFileSync(TODAY_LIST_FILE, JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      items: itemsWithRegion
    }, null, 2), 'utf8');

    log(`✅ today-list.json 저장 완료 (${itemsWithRegion.length}건)`);

    // 이메일로 목록 알림 발송
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

    // ★ 타겟 공고 먼저 (강조)
    if (targetItems.length > 0) {
      emailBody += `🎯 ★ 추천 공고 (청년·소상공인·창업자 대상) ${targetItems.length}건\n`;
      emailBody += `${'='.repeat(50)}\n\n`;
      targetItems.forEach(item => {
        emailBody += `⭐【${item.idx}】 [${item.region}] ${item.cleanTitle}\n`;
        emailBody += `📅 ${item.date}\n`;
        emailBody += `🔗 ${item.url}\n`;
        emailBody += `${'-'.repeat(40)}\n\n`;
      });
    }

    // 기타 공고
    if (otherItems.length > 0) {
      emailBody += `📁 기타 공고 ${otherItems.length}건\n`;
      emailBody += `${'='.repeat(50)}\n\n`;
      otherItems.forEach(item => {
        emailBody += `【${item.idx}】 [${item.region}] ${item.cleanTitle}\n`;
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
  } finally {
    await browser.close();
  }

  log('=== 공고 목록 수집 종료 ===');
}

main();
