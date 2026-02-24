require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'collected_ids.json');
const TODAY_LIST_FILE = path.join(__dirname, 'docs', 'today-list.json');
const DAILY_DIR = path.join(__dirname, 'docs', 'daily');

// =====================================================
// 수집 사이트 설정
// =====================================================
const SOURCES = {
  bizinfo: {
    id: 'bizinfo',
    name: '기업마당',
    icon: '🏢',
    color: '#1a4fa0',
    url: 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do?schPblancDiv=01',
  },
  kstartup: {
    id: 'kstartup',
    name: 'K-Startup',
    icon: '🚀',
    color: '#e8360e',
    url: 'https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schMenuId=00000004&schBizPbancSe=BIZPBANC_SE002',
  },
  sbiz: {
    id: 'sbiz',
    name: '소상공인진흥공단',
    icon: '🏪',
    color: '#2ecc71',
    url: 'https://www.semas.or.kr/web/board/webBoardList.kmdc?bbs_cd_n=2&schStr=',
  },
  smtech: {
    id: 'smtech',
    name: '중소기업기술',
    icon: '🔬',
    color: '#9b59b6',
    url: 'https://www.smtech.go.kr/front/ifg/no/notice02_list.do',
  },
};

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
  // 다양한 ID 패턴 추출
  const patterns = [
    /pblancId=([A-Z0-9_]+)/,
    /pbancSn=([0-9]+)/,
    /ancmId=([0-9]+)/,
    /biz_no=([0-9]+)/,
    /seq=([0-9]+)/,
    /id=([0-9]+)/,
  ];
  for (const pat of patterns) {
    const m = url.match(pat);
    if (m) return m[1];
  }
  // URL 해시로 대체
  return Buffer.from(url).toString('base64').slice(0, 20);
}

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
    '스타트업', '벤처', '창업기업', '신생기업',
    '중소기업', '소규모',
    '창업자', '창업지원', '창업육성',
  ];
  return keywords.some(kw => title.includes(kw));
}

function getCategory(title) {
  if (title.includes('교육') || title.includes('강좌') || title.includes('아카데미') ||
      title.includes('연수') || title.includes('훈련') || title.includes('강의') ||
      title.includes('부트캠프') || title.includes('캠프')) return '창업교육';
  if (title.includes('멘토') || title.includes('컨설팅') || title.includes('코칭') ||
      title.includes('자문') || title.includes('진단') || title.includes('상담')) return '컨설팅/멘토링';
  if (title.includes('글로벌') || title.includes('해외') || title.includes('수출') ||
      title.includes('국제') || title.includes('무역')) return '글로벌';
  if (title.includes('공간') || title.includes('시설') || title.includes('입주') ||
      title.includes('사무실') || title.includes('센터') || title.includes('공유오피스')) return '시설제공';
  if (title.includes('투자') || title.includes('융자') || title.includes('대출') ||
      title.includes('보증') || title.includes('펀드') || title.includes('자금') ||
      title.includes('지원금') || title.includes('보조금') || title.includes('R&D') ||
      title.includes('연구개발')) return '자금지원';
  if (title.includes('판로') || title.includes('마케팅') || title.includes('홍보') ||
      title.includes('전시') || title.includes('박람회') || title.includes('유통')) return '판로/마케팅';
  return '사업화';
}

function getRegionCategory(title) {
  if (title.includes('서울')) return '서울';
  if (title.includes('경기') || title.includes('수원') || title.includes('성남') ||
      title.includes('고양') || title.includes('용인') || title.includes('부천')) return '경기';
  if (title.includes('인천')) return '인천';
  if (title.includes('부산')) return '부산';
  if (title.includes('대구')) return '대구';
  if (title.includes('대전')) return '대전';
  if (title.includes('광주')) return '광주';
  if (title.includes('울산')) return '울산';
  if (title.includes('세종')) return '세종';
  if (title.includes('강원') || title.includes('춘천') || title.includes('원주')) return '강원';
  if (title.includes('충북') || title.includes('청주')) return '충북';
  if (title.includes('충남') || title.includes('천안') || title.includes('아산')) return '충남';
  if (title.includes('전북') || title.includes('전주')) return '전북';
  if (title.includes('전남') || title.includes('목포') || title.includes('여수')) return '전남';
  if (title.includes('경북') || title.includes('포항') || title.includes('구미')) return '경북';
  if (title.includes('경남') || title.includes('창원') || title.includes('진주')) return '경남';
  if (title.includes('제주')) return '제주';
  return '전국';
}

function processItems(rawItems, sourceId, db, today) {
  const results = [];
  const seenTitles = new Set(); // 제목 기준 중복 제거

  for (const item of rawItems) {
    const id = `${sourceId}_${extractId(item.url)}`;
    if (db[id]) continue; // 이미 수집된 공고 스킵

    // 제목 정규화 (공백/특수문자 제거 후 비교)
    const cleanTitle = item.title.replace(/^\[[가-힣A-Za-z0-9\s]+\]\s*/, '').trim();
    const normalizedTitle = cleanTitle.replace(/\s+/g, ' ').trim();
    if (seenTitles.has(normalizedTitle)) continue; // 같은 제목 중복 스킵
    seenTitles.add(normalizedTitle);

    results.push({
      id,
      source: sourceId,
      title: item.title,
      url: item.url,
      date: item.date || '',
      region: item.region || '전국',
      regionCategory: getRegionCategory(item.title),
      category: getCategory(item.title),
      cleanTitle,
      isTarget: isTargetAudience(item.title),
    });
  }
  return results;
}

// =====================================================
// 사이트별 수집 함수
// =====================================================

// 1. 기업마당
async function collectBizinfo(page, db) {
  log('📡 [기업마당] 수집 시작...');
  const BASE_URL = SOURCES.bizinfo.url;
  const rawItems = [];
  let currentPage = 1;

  while (currentPage <= 15) {
    const url = currentPage === 1 ? BASE_URL : `${BASE_URL}&cpage=${currentPage}`;
    try {
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
        const id = `bizinfo_${extractId(item.url)}`;
        if (db[id]) { break; }
        rawItems.push(item);
        newCount++;
      }

      log(`  [기업마당] 페이지 ${currentPage}: ${newCount}개 신규`);
      if (newCount === 0) break;

      const hasNext = await page.evaluate(cp => {
        const links = Array.from(document.querySelectorAll('.page_wrap a'));
        return links.some(a => a.innerText.trim() === String(cp + 1));
      }, currentPage);
      if (!hasNext) break;
      currentPage++;
    } catch (e) {
      log(`  [기업마당] 페이지 ${currentPage} 오류: ${e.message}`);
      break;
    }
  }
  log(`✅ [기업마당] 총 ${rawItems.length}건 수집`);
  return rawItems;
}

// 2. K-Startup - 실제 구조: board_list-wrap > ul > li, a[href*=go_view], p.tit, p.date
async function collectKStartup(page, db) {
  log('📡 [K-Startup] 수집 시작...');
  const BASE_URL = SOURCES.kstartup.url;
  const rawItems = [];
  let currentPage = 1;

  while (currentPage <= 10) {
    try {
      const url = currentPage === 1 ? BASE_URL : `${BASE_URL}&schPage=${currentPage}`;
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2500));

      const items = await page.evaluate(() => {
        const results = [];
        // K-Startup 실제 구조: board_list-wrap 안의 li 항목
        document.querySelectorAll('#bizPbancList li, .board_list-wrap li').forEach(li => {
          // go_view(ID) 패턴의 a 태그
          const a = li.querySelector('a[href*="go_view"], a[href*="bizpbanc"]');
          if (!a) return;

          // 제목: p.tit 또는 .tit_wrap p.tit
          const titleEl = li.querySelector('p.tit, .tit_wrap p, .tit');
          const title = titleEl ? titleEl.innerText.trim() : a.innerText.trim();

          // 날짜: p.date 또는 .date
          const dateEl = li.querySelector('p.date, .date, .period');
          const date = dateEl ? dateEl.innerText.trim() : '';

          // URL 구성: go_view(ID) → ?schM=view&pbancSn=ID
          let href = a.href;
          const goViewMatch = a.getAttribute('onclick')?.match(/go_view\((\d+)\)/) ||
                              a.getAttribute('href')?.match(/go_view\((\d+)\)/);
          if (goViewMatch) {
            href = `https://www.k-startup.go.kr/web/contents/bizpbanc-ongoing.do?schM=view&pbancSn=${goViewMatch[1]}`;
          }

          if (title && title.length > 5) results.push({ title, url: href, date });
        });
        return results;
      });

      if (items.length === 0) break;

      let newCount = 0;
      for (const item of items) {
        const id = `kstartup_${extractId(item.url)}`;
        if (db[id]) { break; }
        rawItems.push(item);
        newCount++;
      }

      log(`  [K-Startup] 페이지 ${currentPage}: ${newCount}개 신규`);
      if (newCount === 0) break;

      const hasNext = await page.evaluate(cp => {
        const links = Array.from(document.querySelectorAll('.pagination a, .paging a, .page_btn'));
        return links.some(a => a.innerText.trim() === String(cp + 1));
      }, currentPage);
      if (!hasNext) break;
      currentPage++;
    } catch (e) {
      log(`  [K-Startup] 페이지 ${currentPage} 오류: ${e.message}`);
      break;
    }
  }
  log(`✅ [K-Startup] 총 ${rawItems.length}건 수집`);
  return rawItems;
}

// 3. 소상공인진흥공단 - 실제 구조: table tbody tr, a.board_title or a
async function collectSbiz(page, db) {
  log('📡 [소상공인진흥공단] 수집 시작...');
  const BASE_URL = SOURCES.sbiz.url;
  const rawItems = [];
  let currentPage = 1;

  while (currentPage <= 10) {
    try {
      const url = currentPage === 1 ? BASE_URL : `${BASE_URL}&pageIndex=${currentPage}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      const items = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('table tbody tr').forEach(tr => {
          const a = tr.querySelector('a');
          if (!a) return;
          const title = a.innerText.trim();
          const tds = Array.from(tr.querySelectorAll('td'));
          // 날짜 컬럼 찾기 (날짜 형식 포함된 td)
          let date = '';
          for (const td of tds) {
            const text = td.innerText.trim();
            if (/\d{4}[\.\-]\d{2}[\.\-]\d{2}/.test(text)) { date = text; }
          }
          if (!date) date = tds[tds.length - 1]?.innerText?.trim() || '';
          if (title && title.length > 5) results.push({ title, url: a.href, date });
        });
        return results;
      });

      if (items.length === 0) break;

      let newCount = 0;
      for (const item of items) {
        const id = `sbiz_${extractId(item.url)}`;
        if (db[id]) { break; }
        rawItems.push(item);
        newCount++;
      }

      log(`  [소상공인진흥공단] 페이지 ${currentPage}: ${newCount}개 신규`);
      if (newCount === 0) break;

      const hasNext = await page.evaluate(cp => {
        const links = Array.from(document.querySelectorAll('.paging a, .pagination a, .board_paging a'));
        return links.some(a => a.innerText.trim() === String(cp + 1));
      }, currentPage);
      if (!hasNext) break;
      currentPage++;
    } catch (e) {
      log(`  [소상공인진흥공단] 페이지 ${currentPage} 오류: ${e.message}`);
      break;
    }
  }
  log(`✅ [소상공인진흥공단] 총 ${rawItems.length}건 수집`);
  return rawItems;
}

// 4. 중소기업기술(smtech) - 실제 구조: table tbody tr, a.board, td.ac (날짜)
async function collectSmtech(page, db) {
  log('📡 [중소기업기술] 수집 시작...');
  const BASE_URL = SOURCES.smtech.url;
  const rawItems = [];
  let currentPage = 1;

  while (currentPage <= 10) {
    try {
      const url = currentPage === 1 ? BASE_URL : `${BASE_URL}?pageIndex=${currentPage}`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await new Promise(r => setTimeout(r, 2000));

      const items = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('table tbody tr').forEach(tr => {
          // smtech는 a.board 클래스로 공고 링크 표시
          const a = tr.querySelector('a.board');
          if (!a) return;
          const title = a.innerText.trim();
          // 날짜: 형식 "YYYY. MM. DD ~ YYYY. MM. DD" 인 td.ac
          const dateTds = Array.from(tr.querySelectorAll('td.ac'));
          let date = '';
          for (const td of dateTds) {
            const text = td.innerText.trim();
            if (/\d{4}\./.test(text)) { date = text; break; }
          }
          const href = a.href.startsWith('http') ? a.href : `https://www.smtech.go.kr${a.getAttribute('href')}`;
          if (title && title.length > 5) results.push({ title, url: href, date });
        });
        return results;
      });

      if (items.length === 0) break;

      let newCount = 0;
      for (const item of items) {
        const id = `smtech_${extractId(item.url)}`;
        if (db[id]) { break; }
        rawItems.push(item);
        newCount++;
      }

      log(`  [중소기업기술] 페이지 ${currentPage}: ${newCount}개 신규`);
      if (newCount === 0) break;

      const hasNext = await page.evaluate(cp => {
        const links = Array.from(document.querySelectorAll('.paging a, .pagination a'));
        return links.some(a => a.innerText.trim() === String(cp + 1));
      }, currentPage);
      if (!hasNext) break;
      currentPage++;
    } catch (e) {
      log(`  [중소기업기술] 페이지 ${currentPage} 오류: ${e.message}`);
      break;
    }
  }
  log(`✅ [중소기업기술] 총 ${rawItems.length}건 수집`);
  return rawItems;
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

async function main() {
  log('=== 공고 목록 수집 시작 ===');
  const today = new Date().toISOString().slice(0, 10);
  const db = loadDB();

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // 출처별 수집 결과
  const sourceResults = {};
  let totalNew = 0;

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 1. 기업마당
    const bizinfoRaw = await collectBizinfo(page, db);
    const bizinfoItems = processItems(bizinfoRaw, 'bizinfo', db, today);
    sourceResults.bizinfo = bizinfoItems;
    totalNew += bizinfoItems.length;

    // 2. K-Startup
    const kstartupRaw = await collectKStartup(page, db);
    const kstartupItems = processItems(kstartupRaw, 'kstartup', db, today);
    sourceResults.kstartup = kstartupItems;
    totalNew += kstartupItems.length;

    // 3. 소상공인마당
    const sbizRaw = await collectSbiz(page, db);
    const sbizItems = processItems(sbizRaw, 'sbiz', db, today);
    sourceResults.sbiz = sbizItems;
    totalNew += sbizItems.length;

    // 4. 중소기업기술
    const smtechRaw = await collectSmtech(page, db);
    const smtechItems = processItems(smtechRaw, 'smtech', db, today);
    sourceResults.smtech = smtechItems;
    totalNew += smtechItems.length;

  } catch (err) {
    log(`수집 오류: ${err.message}`);
    console.error(err);
  } finally {
    await browser.close();
  }

  log(`\n📊 수집 결과 요약:`);
  let totalTarget = 0;
  Object.entries(sourceResults).forEach(([src, items]) => {
    const targets = items.filter(i => i.isTarget).length;
    totalTarget += targets;
    log(`  ${SOURCES[src].icon} ${SOURCES[src].name}: ${items.length}건 (추천 ${targets}건)`);
  });
  log(`  📌 전체: ${totalNew}건 (추천 ${totalTarget}건)`);

  // 저장 데이터 구성
  const saveData = {
    date: today,
    total: totalNew,
    targetCount: totalTarget,
    sources: Object.fromEntries(
      Object.entries(sourceResults).map(([src, items]) => [
        src,
        {
          ...SOURCES[src],
          count: items.length,
          targetCount: items.filter(i => i.isTarget).length,
          items,
        }
      ])
    ),
  };

  // 파일 저장
  fs.mkdirSync(path.dirname(TODAY_LIST_FILE), { recursive: true });
  fs.writeFileSync(TODAY_LIST_FILE, JSON.stringify(saveData, null, 2), 'utf8');

  fs.mkdirSync(DAILY_DIR, { recursive: true });
  fs.writeFileSync(path.join(DAILY_DIR, `${today}.json`), JSON.stringify(saveData, null, 2), 'utf8');
  log(`✅ daily/${today}.json 저장 완료`);

  // 8일 이전 파일 삭제
  cleanOldDailyFiles();

  // collected_ids 업데이트
  Object.values(sourceResults).flat().forEach(item => {
    db[item.id] = today;
  });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');

  if (totalNew === 0) {
    log('신규 공고 없음. 이메일 발송 생략.');
    return;
  }

  // 이메일 발송
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    const TO_EMAIL = process.env.TO_EMAIL || 'nagairams1@gmail.com';
    const pageUrl = 'https://fanyfall-a11y.github.io/bizinfo-scraper/';

    let emailBody = `📋 오늘 신규 지원사업 공고 ${totalNew}건 수집 완료!\n`;
    emailBody += `🎯 추천 공고 ${totalTarget}건\n\n`;
    emailBody += `👉 공고 선택 페이지:\n${pageUrl}\n\n`;
    emailBody += `${'='.repeat(50)}\n\n`;

    Object.entries(sourceResults).forEach(([src, items]) => {
      if (items.length === 0) return;
      const source = SOURCES[src];
      const targets = items.filter(i => i.isTarget);
      const others = items.filter(i => !i.isTarget);

      emailBody += `${source.icon} ${source.name} - ${items.length}건\n`;
      emailBody += `${'='.repeat(50)}\n\n`;

      targets.forEach(item => {
        emailBody += `⭐ [추천] [${item.regionCategory}] [${item.category}] ${item.cleanTitle}\n`;
        emailBody += `📅 마감: ${item.date} | 🔗 ${item.url}\n${'-'.repeat(40)}\n\n`;
      });
      others.forEach(item => {
        emailBody += `[${item.regionCategory}] [${item.category}] ${item.cleanTitle}\n`;
        emailBody += `📅 마감: ${item.date} | 🔗 ${item.url}\n${'-'.repeat(40)}\n\n`;
      });
    });

    await transporter.sendMail({
      from: `"나혼자창업 자동수집" <${process.env.GMAIL_USER}>`,
      to: TO_EMAIL,
      subject: `🎯 추천 ${totalTarget}건 포함 오늘 신규 공고 ${totalNew}건 (${new Date().toLocaleDateString('ko-KR')})`,
      text: emailBody,
    });
    log(`📧 이메일 발송 완료 → ${TO_EMAIL}`);
  } catch (e) {
    log(`이메일 발송 오류: ${e.message}`);
  }

  log('=== 공고 목록 수집 종료 ===');
}

main();
