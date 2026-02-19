const puppeteer = require('puppeteer');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const BASE_URL = 'https://www.bizinfo.go.kr';
const LIST_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do?schPblancDiv=01';
const DB_FILE = path.join(__dirname, 'collected_ids.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(r => rl.question(q, r)); }

// 수집 이력 DB 로드
function loadDB() {
  if (fs.existsSync(DB_FILE)) {
    try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return {}; }
  }
  return {};
}

// 수집 이력 DB 저장
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}

// URL에서 공고 ID 추출
function extractId(url) {
  const match = url.match(/pblancId=([A-Z0-9_]+)/);
  return match ? match[1] : null;
}

function sanitize(name) {
  return name.replace(/[\/\\:*?"<>|\n\r]/g, '_').trim().slice(0, 80);
}

// 지역 추출 (제목 또는 지자체 정보에서)
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

// 파일 다운로드
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

// 전체 페이지 목록 수집 (skipCollected: 이미 수집된 항목 건너뜀)
async function getAllItems(page, maxPages, skipCollected = false) {
  const db = loadDB();
  const allItems = [];
  let currentPage = 1;
  let hitExisting = false; // 기존 수집 항목 만나면 중단 플래그

  while (currentPage <= maxPages) {
    const url = currentPage === 1
      ? LIST_URL
      : `${LIST_URL}&cpage=${currentPage}`;

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1500));

    const items = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('div.table_Type_1 td.txt_l a[href*="pblancId"]').forEach(a => {
        const title = a.innerText.trim();
        const href = a.href;
        const tds = Array.from(a.closest('td')?.parentElement?.querySelectorAll('td') || []);
        const date = tds[6]?.innerText?.trim() || tds[5]?.innerText?.trim() || '';
        if (title && href && title.length > 5) {
          results.push({ title, url: href, date });
        }
      });
      return results;
    });

    if (items.length === 0) break;

    let newCount = 0;
    for (const item of items) {
      const id = extractId(item.url);
      if (skipCollected && id && db[id]) {
        hitExisting = true;
        continue; // 이미 수집된 항목 건너뜀
      }
      allItems.push(item);
      newCount++;
    }

    console.log(`  페이지 ${currentPage}: ${items.length}개 중 ${newCount}개 신규`);

    // 신규 항목이 없고 이미 수집된 항목을 만났으면 중단
    if (skipCollected && hitExisting && newCount === 0) {
      console.log('  → 이후 페이지는 모두 기수집 항목입니다. 중단합니다.');
      break;
    }

    const hasNext = await page.evaluate((cp) => {
      const links = Array.from(document.querySelectorAll('.page_wrap a'));
      return links.some(a => a.innerText.trim() === String(cp + 1));
    }, currentPage);

    if (!hasNext) break;
    currentPage++;
  }

  return allItems;
}

// 상세 페이지 스크레이핑
async function scrapeDetail(page, url, outputDir) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    const extracted = await page.evaluate(() => {
      // 제목
      let title = '';
      for (const h of document.querySelectorAll('h2, h3')) {
        const t = h.innerText.trim();
        if (t.length > title.length && t.length > 5 &&
          !['정책정보','지원사업 공고','활용정보','고객알림','이용안내'].includes(t)) {
          title = t;
        }
      }

      // 기본 정보 (소관부처, 신청기간 등)
      const details = [];
      document.querySelectorAll('li').forEach(li => {
        const label = li.querySelector('.s_title')?.innerText.trim();
        const value = li.querySelector('.txt')?.innerText.replace(/\s+/g, ' ').trim();
        if (label && value) details.push({ label, value });
      });

      // 지원 대상 별도 추출
      let target = '';
      for (const d of details) {
        if (d.label.includes('사업개요')) {
          const text = d.value;
          const match = text.match(/☞([^☞※]+)/g);
          if (match) target = match.map(m => m.replace('☞', '').trim()).join('\n');
          break;
        }
      }

      // 첨부파일 목록
      const attachments = [];
      document.querySelectorAll('.file_list a, .attach_list a, .board_file a, a[href*="fileDown"], a[href*="download"]').forEach(a => {
        const name = a.innerText.trim() || a.getAttribute('title') || '첨부파일';
        const href = a.href;
        if (href && !href.includes('javascript') && name.length > 1) {
          // 다운로드/바로보기 텍스트 제외
          if (!['다운로드','바로보기','download'].includes(name.toLowerCase())) {
            attachments.push({ name, url: href });
          }
        }
      });

      // 첨부파일 링크 (바로보기/다운로드 버튼 옆 파일명)
      if (attachments.length === 0) {
        document.querySelectorAll('.file_area li, .attach_area li, .down_list li').forEach(li => {
          const nameEl = li.querySelector('.file_name, .name, span') ;
          const dlBtn = li.querySelector('a[href*="fileDown"], a[href*="download"], a');
          if (nameEl && dlBtn) {
            attachments.push({ name: nameEl.innerText.trim(), url: dlBtn.href });
          }
        });
      }

      // 등록일 추출
      const dateEl = document.querySelector('.date, .reg_date, .write_date, .board_date');
      const regDate = dateEl?.innerText?.replace(/[^0-9\.\-]/g, '').trim() || '';

      return { title, details, target, attachments, regDate };
    });

    // 첨부파일 다운로드
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
          process.stdout.write(`    첨부파일 저장: ${filename}\n`);
        } catch (e) {
          process.stdout.write(`    첨부파일 실패: ${att.name}\n`);
        }
      }
    }

    return { ...extracted, downloadedFiles, url };
  } catch (err) {
    console.log(`  ⚠ 접속 실패: ${url}`);
    return null;
  }
}

// 포맷팅
function formatForBlog(item, region) {
  const lines = [];
  lines.push('='.repeat(60));
  lines.push(`[제목] ${item.title}`);
  lines.push(`[지역] ${region}`);
  lines.push('='.repeat(60));
  lines.push('');

  if (item.regDate) {
    lines.push(`📅 등록일: ${item.regDate}`);
    lines.push('');
  }

  if (item.details.length > 0) {
    lines.push('【기본 정보】');
    item.details.forEach(({ label, value }) => {
      if (value && !label.includes('사업개요') && !label.includes('사업신청')) {
        lines.push(`  ▪ ${label}: ${value}`);
      }
    });
    lines.push('');
  }

  const overview = item.details.find(d => d.label.includes('사업개요'));
  if (overview) {
    lines.push('【사업 개요】');
    lines.push(overview.value);
    lines.push('');
  }

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

async function main() {
  console.log('\n========================================');
  console.log('  비즈인포 지원사업 스크레이퍼 v2');
  console.log('========================================\n');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  try {
    while (true) {
      const db = loadDB();
      const dbCount = Object.keys(db).length;

      console.log('\n[메뉴]');
      console.log('1. 현재 페이지만 수집 (15개)');
      console.log('2. 여러 페이지 수집');
      console.log(`3. 신규 공고만 수집 (기수집: ${dbCount}건)`);
      console.log('4. 종료');

      const menu = await ask('\n선택 (1-4): ');
      if (menu === '4') break;

      let maxPages = 1;
      let skipCollected = false;

      if (menu === '2') {
        const p = await ask('몇 페이지까지 수집할까요? (예: 5): ');
        maxPages = parseInt(p) || 1;
      } else if (menu === '3') {
        const p = await ask('최대 몇 페이지까지 확인할까요? (예: 10, 기본: 5): ');
        maxPages = parseInt(p) || 5;
        skipCollected = true;
        console.log(`\n신규 공고 탐색 시작 (최대 ${maxPages}페이지)...`);
      } else if (menu !== '1') {
        console.log('1, 2, 3, 4 중 선택하세요.');
        continue;
      }

      console.log('\n목록 수집 중...');
      const items = await getAllItems(page, maxPages, skipCollected);

      if (items.length === 0) {
        console.log('수집된 항목이 없습니다.');
        continue;
      }

      // 등록일 기준 정렬 (최신순)
      items.sort((a, b) => {
        const da = a.date.replace(/\./g, '');
        const db = b.date.replace(/\./g, '');
        return db.localeCompare(da);
      });

      console.log(`\n총 ${items.length}개 공고 수집됨\n`);
      items.forEach((item, i) => {
        console.log(`  ${String(i+1).padStart(3)}. [${item.date || '날짜없음'}] ${item.title}`);
      });

      const input = await ask('\n스크레이핑할 번호 (전체: all, 예: 1,3,5): ');
      let selected = [];
      if (input.trim().toLowerCase() === 'all') {
        selected = items;
      } else {
        const nums = input.split(',').map(n => parseInt(n.trim()) - 1).filter(n => n >= 0 && n < items.length);
        selected = nums.map(i => items[i]);
      }

      if (selected.length === 0) { console.log('선택된 항목이 없습니다.'); continue; }

      // 출력 폴더 생성
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outputDir = path.join(__dirname, 'output', `bizinfo_${timestamp}`);
      fs.mkdirSync(outputDir, { recursive: true });

      console.log(`\n${selected.length}개 항목 수집 중...\n`);

      const results = [];
      for (let i = 0; i < selected.length; i++) {
        const item = selected[i];
        console.log(`  [${i+1}/${selected.length}] ${item.title}`);
        const detail = await scrapeDetail(page, item.url, outputDir);
        if (detail) {
          detail.listDate = item.date;
          results.push(detail);
        }
      }

      if (results.length === 0) { console.log('수집된 내용이 없습니다.'); continue; }

      // 등록일 기준 정렬
      results.sort((a, b) => {
        const da = (a.regDate || a.listDate || '').replace(/\./g, '');
        const db = (b.regDate || b.listDate || '').replace(/\./g, '');
        return db.localeCompare(da);
      });

      // 지역별 그룹핑
      const regionGroups = {};
      results.forEach(item => {
        const region = extractRegion(item.title, item.details);
        if (!regionGroups[region]) regionGroups[region] = [];
        regionGroups[region].push(item);
      });

      // 전체 파일 저장
      const allFile = path.join(outputDir, '전체_지원사업_목록.txt');
      let allContent = `비즈인포 지원사업 스크레이핑 결과\n`;
      allContent += `수집 일시: ${new Date().toLocaleString('ko-KR')}\n`;
      allContent += `수집 건수: ${results.length}건\n\n`;

      // 지역별 파일 저장
      const regionOrder = ['서울','경기','부산','대구','인천','광주','대전','울산','세종','강원','충북','충남','전북','전남','경북','경남','제주','전국'];
      const sortedRegions = Object.keys(regionGroups).sort((a, b) => {
        return regionOrder.indexOf(a) - regionOrder.indexOf(b);
      });

      // 목차
      allContent += '【지역별 목차】\n';
      sortedRegions.forEach(region => {
        allContent += `  ${region} (${regionGroups[region].length}건)\n`;
        regionGroups[region].forEach(item => {
          allContent += `    - [${item.regDate || item.listDate || ''}] ${item.title}\n`;
        });
      });
      allContent += '\n' + '='.repeat(60) + '\n\n';

      // 지역별 내용
      sortedRegions.forEach(region => {
        allContent += `\n${'★'.repeat(3)} ${region} (${regionGroups[region].length}건) ${'★'.repeat(3)}\n\n`;
        regionGroups[region].forEach(item => {
          allContent += formatForBlog(item, region);
        });

        // 지역별 개별 파일도 저장
        const regionFile = path.join(outputDir, `${region}_지원사업.txt`);
        let regionContent = `${region} 지원사업 목록\n수집: ${new Date().toLocaleString('ko-KR')}\n\n`;
        regionGroups[region].forEach(item => {
          regionContent += formatForBlog(item, region);
        });
        fs.writeFileSync(regionFile, regionContent, 'utf8');
      });

      fs.writeFileSync(allFile, allContent, 'utf8');

      // 수집 이력 DB 업데이트
      const dbUpdate = loadDB();
      results.forEach(item => {
        const id = extractId(item.url);
        if (id) {
          dbUpdate[id] = {
            title: item.title,
            collectedAt: new Date().toISOString(),
            regDate: item.regDate || item.listDate || ''
          };
        }
      });
      saveDB(dbUpdate);
      console.log(`  수집 이력 저장: ${Object.keys(dbUpdate).length}건 누적`);

      console.log(`\n✅ 저장 완료!`);
      console.log(`   폴더: ${outputDir}`);
      console.log(`   전체: 전체_지원사업_목록.txt`);
      sortedRegions.forEach(r => console.log(`   지역: ${r}_지원사업.txt`));
      if (fs.existsSync(path.join(outputDir, 'attachments'))) {
        console.log(`   첨부파일: attachments/ 폴더`);
      }

      const again = await ask('\n계속하시겠습니까? (y/n): ');
      if (again.toLowerCase() !== 'y') break;
    }
  } catch (err) {
    console.error('오류:', err.message);
  } finally {
    await browser.close();
    rl.close();
  }
}

main();
