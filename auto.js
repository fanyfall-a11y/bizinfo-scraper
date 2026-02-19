// 자동 실행용 스크립트 (대화 없이 신규 공고만 수집)
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const BASE_URL = 'https://www.bizinfo.go.kr';
const LIST_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do?schPblancDiv=01';
const DB_FILE = path.join(__dirname, 'collected_ids.json');
const LOG_FILE = path.join(__dirname, 'auto_log.txt');

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

function downloadFile(url, filepath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(filepath);
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlink(filepath, () => {});
        downloadFile(res.headers.location, filepath).then(resolve).catch(reject);
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', err => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
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

async function scrapeDetail(page, url, outputDir) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const extracted = await page.evaluate(() => {
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

      let target = '';
      for (const d of details) {
        if (d.label.includes('사업개요')) {
          const match = d.value.match(/☞([^☞※]+)/g);
          if (match) target = match.map(m => m.replace('☞', '').trim()).join('\n');
          break;
        }
      }

      const attachments = [];
      document.querySelectorAll('a[href*="fileDown"], a[href*="download"]').forEach(a => {
        const name = a.innerText.trim() || a.getAttribute('title') || '첨부파일';
        const href = a.href;
        if (href && !href.includes('javascript') && name.length > 1 &&
          !['다운로드','바로보기','download'].includes(name.toLowerCase())) {
          attachments.push({ name, url: href });
        }
      });

      const dateEl = document.querySelector('.date, .reg_date, .write_date');
      const regDate = dateEl?.innerText?.replace(/[^0-9\.\-]/g, '').trim() || '';

      return { title, details, target, attachments, regDate };
    });

    const downloadedFiles = [];
    if (extracted.attachments.length > 0 && outputDir) {
      const attachDir = path.join(outputDir, 'attachments', sanitize(extracted.title));
      if (!fs.existsSync(attachDir)) fs.mkdirSync(attachDir, { recursive: true });

      for (const att of extracted.attachments) {
        try {
          const ext = att.name.includes('.') ? '' : '.pdf';
          const filename = sanitize(att.name) + ext;
          const filepath = path.join(attachDir, filename);
          await downloadFile(att.url, filepath);
          downloadedFiles.push({ name: att.name, path: filepath });
          log(`  첨부파일 저장: ${filename}`);
        } catch { log(`  첨부파일 실패: ${att.name}`); }
      }
    }

    return { ...extracted, downloadedFiles, url };
  } catch {
    log(`접속 실패: ${url}`);
    return null;
  }
}

function formatForBlog(item, region) {
  const lines = [];
  lines.push('='.repeat(60));
  lines.push(`[제목] ${item.title}`);
  lines.push(`[지역] ${region}`);
  lines.push('='.repeat(60));
  lines.push('');
  if (item.regDate) { lines.push(`📅 등록일: ${item.regDate}`); lines.push(''); }

  if (item.details.length > 0) {
    lines.push('【기본 정보】');
    item.details.forEach(({ label, value }) => {
      if (value && !label.includes('사업개요') && !label.includes('사업신청'))
        lines.push(`  ▪ ${label}: ${value}`);
    });
    lines.push('');
  }

  const overview = item.details.find(d => d.label.includes('사업개요'));
  if (overview) { lines.push('【사업 개요】'); lines.push(overview.value); lines.push(''); }

  if (item.target) {
    lines.push('【지원 대상】');
    item.target.split('\n').forEach(t => lines.push(`  • ${t}`));
    lines.push('');
  }

  const method = item.details.find(d => d.label.includes('사업신청 방법'));
  const contact = item.details.find(d => d.label.includes('문의처'));
  if (method || contact) {
    lines.push('【신청 정보】');
    if (method) lines.push(`  ▪ 신청방법: ${method.value}`);
    if (contact) lines.push(`  ▪ 문의처: ${contact.value}`);
    lines.push('');
  }

  if (item.downloadedFiles.length > 0) {
    lines.push('【첨부 파일】');
    item.downloadedFiles.forEach(f => {
      lines.push(`  📎 ${f.name}`);
      lines.push(`     저장위치: ${f.path}`);
    });
    lines.push('');
  }

  lines.push('【원문 링크】');
  lines.push(item.url);
  lines.push('');
  lines.push('-'.repeat(60));
  lines.push('');
  return lines.join('\n');
}

// 오늘 이미 수집했는지 확인
function alreadyCollectedToday() {
  if (!fs.existsSync(LOG_FILE)) return false;
  const today = new Date().toLocaleDateString('ko-KR'); // 예: 2026. 2. 14.
  const logs = fs.readFileSync(LOG_FILE, 'utf8');
  // 오늘 날짜로 "=== 자동 수집 시작 ===" 기록이 있으면 이미 수집한 것
  const lines = logs.split('\n').reverse();
  for (const line of lines) {
    if (line.includes('=== 자동 수집 시작 ===') && line.includes(today)) {
      return true;
    }
  }
  return false;
}

async function main() {
  // 하루 1번만 수집
  if (alreadyCollectedToday()) {
    console.log(`[${new Date().toLocaleString('ko-KR')}] 오늘 이미 수집 완료. 종료합니다.`);
    return;
  }

  log('=== 자동 수집 시작 ===');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  try {
    const newItems = await getNewItems(page, 10);

    if (newItems.length === 0) {
      log('신규 공고 없음. 종료합니다.');
      return;
    }

    log(`신규 공고 ${newItems.length}건 발견. 상세 수집 시작...`);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputDir = path.join(__dirname, 'output', `auto_${timestamp}`);
    fs.mkdirSync(outputDir, { recursive: true });

    const results = [];
    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      log(`[${i+1}/${newItems.length}] ${item.title}`);
      const detail = await scrapeDetail(page, item.url, outputDir);
      if (detail) { detail.listDate = item.date; results.push(detail); }
    }

    if (results.length === 0) { log('수집 결과 없음.'); return; }

    // 등록일 정렬
    results.sort((a, b) => {
      const da = (a.regDate || a.listDate || '').replace(/\./g, '');
      const db2 = (b.regDate || b.listDate || '').replace(/\./g, '');
      return db2.localeCompare(da);
    });

    // 지역별 그룹핑
    const regionGroups = {};
    results.forEach(item => {
      const region = extractRegion(item.title, item.details);
      if (!regionGroups[region]) regionGroups[region] = [];
      regionGroups[region].push(item);
    });

    const regionOrder = ['서울','경기','부산','대구','인천','광주','대전','울산','세종','강원','충북','충남','전북','전남','경북','경남','제주','전국'];
    const sortedRegions = Object.keys(regionGroups).sort((a, b) => regionOrder.indexOf(a) - regionOrder.indexOf(b));

    let allContent = `비즈인포 신규 지원사업 자동 수집\n수집 일시: ${new Date().toLocaleString('ko-KR')}\n수집 건수: ${results.length}건\n\n`;
    allContent += '【지역별 목차】\n';
    sortedRegions.forEach(region => {
      allContent += `  ${region} (${regionGroups[region].length}건)\n`;
      regionGroups[region].forEach(item => {
        allContent += `    - [${item.regDate || item.listDate || ''}] ${item.title}\n`;
      });
    });
    allContent += '\n' + '='.repeat(60) + '\n\n';

    sortedRegions.forEach(region => {
      allContent += `\n${'★'.repeat(3)} ${region} (${regionGroups[region].length}건) ${'★'.repeat(3)}\n\n`;
      regionGroups[region].forEach(item => { allContent += formatForBlog(item, region); });

      const regionFile = path.join(outputDir, `${region}_지원사업.txt`);
      let regionContent = `${region} 신규 지원사업\n수집: ${new Date().toLocaleString('ko-KR')}\n\n`;
      regionGroups[region].forEach(item => { regionContent += formatForBlog(item, region); });
      fs.writeFileSync(regionFile, regionContent, 'utf8');
    });

    const allFile = path.join(outputDir, '전체_신규_지원사업.txt');
    fs.writeFileSync(allFile, allContent, 'utf8');

    // DB 업데이트
    const db = loadDB();
    results.forEach(item => {
      const id = extractId(item.url);
      if (id) db[id] = { title: item.title, collectedAt: new Date().toISOString(), regDate: item.regDate || item.listDate || '' };
    });
    saveDB(db);

    log(`✅ 완료! 저장위치: ${outputDir}`);
    log(`   누적 수집: ${Object.keys(db).length}건`);

  } catch (err) {
    log(`오류: ${err.message}`);
  } finally {
    await browser.close();
  }

  log('=== 자동 수집 종료 ===\n');
}

main();
