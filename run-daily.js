require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { sendDailyReport } = require('./mailer');
const { google } = require('googleapis');

const LIST_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200View.do?schPblancDiv=01';
const DB_FILE = path.join(__dirname, 'collected_ids.json');
const LOG_FILE = path.join(__dirname, 'auto_log.txt');
const TO_EMAIL = process.env.TO_EMAIL || 'nagairams1@gmail.com';

// Gemini 호출 카운터
const geminiStats = {
  total: 0,           // 전체 호출 수
  callTimes: [],      // 호출 시각 기록 (RPM 계산용)
};

function countGeminiCall(label) {
  geminiStats.total++;
  geminiStats.callTimes.push({ time: Date.now(), label });
}

function getGeminiStats() {
  const now = Date.now();
  // 최근 1분 이내 호출 수
  const recentCalls = geminiStats.callTimes.filter(c => now - c.time < 60000);
  return {
    total: geminiStats.total,
    rpm: recentCalls.length,
  };
}


function log(msg) {
  const line = `[${new Date().toLocaleString('ko-KR')}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
}

// 구글 드라이브 인증
function getDriveAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return auth;
}

// 드라이브에 폴더 생성 (없으면 만들고, 있으면 기존 ID 반환)
async function getOrCreateDriveFolder(drive, name, parentId) {
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id, name)',
  });
  if (res.data.files.length > 0) return res.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });
  return folder.data.id;
}

// 드라이브에 파일 업로드
async function uploadFileToDrive(drive, filePath, fileName, parentId) {
  const fileStream = fs.createReadStream(filePath);
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
    },
    media: {
      body: fileStream,
    },
    fields: 'id, webViewLink',
  });
  return res.data;
}

// 지역 폴더 전체를 드라이브에 업로드 (지역폴더 > 공고폴더 > 파일들)
async function uploadRegionToDrive(drive, regionLocalPath, regionName, rootFolderId) {
  const regionFolderId = await getOrCreateDriveFolder(drive, regionName, rootFolderId);
  const itemDirs = fs.readdirSync(regionLocalPath, { withFileTypes: true }).filter(d => d.isDirectory());
  for (const itemDir of itemDirs) {
    const itemLocalPath = path.join(regionLocalPath, itemDir.name);
    const itemFolderId = await getOrCreateDriveFolder(drive, itemDir.name, regionFolderId);
    const files = fs.readdirSync(itemLocalPath).filter(f => fs.statSync(path.join(itemLocalPath, f)).isFile());
    for (const fileName of files) {
      const filePath = path.join(itemLocalPath, fileName);
      await uploadFileToDrive(drive, filePath, fileName, itemFolderId);
    }
  }
  return regionFolderId;
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

// 상세 페이지 스크래핑 (사업목적, 신청자격, 지원내용, 모집구분 포함)
async function scrapeDetail(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
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

      // HWP 뷰어 iframe URL 추출
      const iframeSrc = document.querySelector('iframe')?.src || '';

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
        regDate,
        iframeSrc
      };
    });
  } catch {
    log(`접속 실패: ${url}`);
    return null;
  }
}

// 429 오류 시 자동 재시도 래퍼 (1차 60초, 2차 120초, 3차 10분, 그 후 한도초과 에러 throw)
async function geminiCallWithRetry(fn, label) {
  const delays = [60000, 120000, 600000]; // 60초 → 120초 → 10분
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const result = await fn();
      // 호출 성공 시 카운트 + 현재 통계 로그
      countGeminiCall(label);
      const stats = getGeminiStats();
      log(`  📊 Gemini 호출 [${label}] 완료 | 전체 ${stats.total}회 | 현재 분당 ${stats.rpm}회`);
      return result;
    } catch (e) {
      const is429 = e.message && (e.message.includes('429') || e.message.includes('quota') || e.message.includes('Too Many'));
      if (is429 && attempt < delays.length) {
        const wait = delays[attempt];
        log(`  ⚠️ [${label}] Gemini 429 오류 → ${wait / 1000}초 대기 후 재시도 (${attempt + 1}/${delays.length})`);
        await new Promise(r => setTimeout(r, wait));
      } else if (is429) {
        // 모든 재시도 소진 → 한도초과 전용 에러
        const quotaErr = new Error('QUOTA_EXCEEDED');
        quotaErr.isQuotaExceeded = true;
        throw quotaErr;
      } else {
        throw e;
      }
    }
  }
}

// HWP 뷰어 스크린샷 전체 캡처 후 Gemini Vision으로 내용 추출
async function extractHwpContent(iframeSrc, title, browser) {
  try {
    log('  📄 HWP 뷰어 스크린샷 캡처 중...');
    const viewerPage = await browser.newPage();
    await viewerPage.setViewport({ width: 1200, height: 1400 });
    await viewerPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await viewerPage.goto(iframeSrc, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    // 총 페이지 수 파악 (최대 6페이지까지만)
    const totalPages = await viewerPage.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/\/\s*(\d+)/);
      return m ? Math.min(parseInt(m[1]), 6) : 3;
    });
    log(`  📄 총 ${totalPages}페이지 캡처 시작`);

    const fs = require('fs');
    const screenshots = [];

    for (let p = 1; p <= totalPages; p++) {
      if (p > 1) {
        // 다음 페이지로 이동
        await viewerPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a'));
          const nextBtn = btns.find(b =>
            b.title?.includes('다음') || b.className?.includes('next') ||
            b.getAttribute('aria-label')?.includes('next') || b.innerText?.trim() === '>'
          );
          if (nextBtn) nextBtn.click();
        });
        await new Promise(r => setTimeout(r, 3000));
      }
      const imgPath = `/tmp/hwp_page_${p}.png`;
      await viewerPage.screenshot({ path: imgPath, fullPage: false });
      screenshots.push(imgPath);
      log(`  📄 페이지 ${p}/${totalPages} 캡처 완료`);
    }
    await viewerPage.close();

    // 스크린샷 전체를 Gemini Vision에 한번에 전달 (1회 호출)
    log('  🤖 Gemini Vision으로 HWP 내용 추출 중...');
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const parts = [{
      text: `다음은 지원사업 공고문 이미지(${totalPages}페이지)입니다. 아래 항목만 정확하게 추출해주세요. 이미지에 없는 내용은 절대 추가하지 마세요.\n\n1. 지원대상(신청자격): 누가 신청할 수 있는지\n2. 지원내용: 지원금액, 지원규모, 지원항목\n3. 신청방법: 어떻게 신청하는지\n\n각 항목을 불릿포인트(•)로 정리해서 아래 형식으로 출력:\n---지원대상---\n(내용)\n---지원내용---\n(내용)\n---신청방법---\n(내용)`
    }];

    for (const imgPath of screenshots) {
      const imgData = fs.readFileSync(imgPath);
      parts.push({ inlineData: { mimeType: 'image/png', data: imgData.toString('base64') } });
    }

    const hwpResult = await geminiCallWithRetry(
      () => model.generateContent(parts),
      'HWP Vision'
    );
    const hwpText = hwpResult.response.text().trim();

    const targetMatch = hwpText.match(/---지원대상---([\s\S]*?)---지원내용---/);
    const amountMatch = hwpText.match(/---지원내용---([\s\S]*?)---신청방법---/);
    const methodMatch = hwpText.match(/---신청방법---([\s\S]*?)$/);

    log('  ✅ HWP 내용 추출 완료');
    return {
      hwpTarget: targetMatch ? targetMatch[1].trim() : '',
      hwpAmount: amountMatch ? amountMatch[1].trim() : '',
      hwpMethod: methodMatch ? methodMatch[1].trim() : '',
    };
  } catch (e) {
    if (e.isQuotaExceeded) throw e; // 한도 초과는 그대로 위로 전달
    log(`  ❌ HWP 추출 3회 모두 실패: ${e.message}`);
    log(`  🚫 Gemini API 오류로 프로그램을 종료합니다.`);
    const fatalErr = new Error('HWP_FATAL');
    fatalErr.isFatal = true;
    throw fatalErr;
  }
}

// Gemini로 멘트 + 신청자격 + 지원내용 + 블로그 3종 생성
async function generateMent(item, browser) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const overview = item.overview || '';
    const title = item.title;
    const period = item.period || item.deadline || '미상';
    const contact = item.contact || '공고 원문 확인';

    // HWP 뷰어가 있으면 추출 (없으면 스킵)
    let hwpTarget = '', hwpAmount = '', hwpMethod = '';
    if (item.iframeSrc && browser) {
      const hwp = await extractHwpContent(item.iframeSrc, title, browser);
      hwpTarget = hwp.hwpTarget;
      hwpAmount = hwp.hwpAmount;
      hwpMethod = hwp.hwpMethod;
      // HWP 추출 후 3초 딜레이
      log('  ⏳ HWP 추출 후 3초 대기 중...');
      await new Promise(r => setTimeout(r, 3000));
    }

    // HWP에서 추출한 내용 + 사업개요 합쳐서 Gemini에 전달
    const enrichedOverview = [
      overview.slice(0, 600),
      hwpTarget ? `[지원대상] ${hwpTarget.slice(0, 400)}` : '',
      hwpAmount ? `[지원내용] ${hwpAmount.slice(0, 400)}` : '',
      hwpMethod ? `[신청방법] ${hwpMethod.slice(0, 200)}` : '',
    ].filter(Boolean).join('\n\n');

    const prompt = `다음 지원사업 공고를 분석해서 아래 형식으로 정리해줘. 반드시 구분자(---)를 정확히 사용해.

[공고명] ${title}
[사업내용] ${enrichedOverview}
[신청기간] ${period}
[문의처] ${contact}

===출력형식 시작===

---썸네일멘트---
(SNS 카드뉴스용. 1~2줄. 이모지 1~2개. 누가/얼마/어떤혜택인지 핵심만. "지원사업 공고가 등록되었습니다" 같은 뻔한 표현 절대 금지)

---신청자격---
(신청 가능한 대상 조건만. 불릿포인트(•)로 3~5줄. 정보 없으면 "공고 원문을 확인해주세요.")

---지원내용---
(지원금액, 지원내용만. 불릿포인트(•)로 3~5줄. 정보 없으면 "공고 원문을 확인해주세요.")

---신청자격_카드용---
(신청자격 중 핵심 제한 조건 최대 3가지만. 업종/업태, 지역, 업력, 규모, 제외조건 등 이 공고에서 가장 중요한 것 우선. 각 조건을 불릿포인트(•)로. 마지막에 "• 자세한 조건은 공고 원문 확인" 추가)

---지원내용_카드용---
(지원내용 중 핵심 3가지만. 지원금액/한도, 지원비율, 지원건수, 지원종류 중 가장 중요한 것 우선. 각 항목을 불릿포인트(•)로. 마지막에 "• 자세한 내용은 공고 원문 확인" 추가)

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

    // 1차 호출: 초안 생성
    const result = await geminiCallWithRetry(
      () => model.generateContent(prompt),
      '초안 생성'
    );
    const firstDraft = result.response.text().trim();

    // 1차 → 2차 사이 3초 딜레이
    log('  ⏳ 검수 전 3초 대기 중...');
    await new Promise(r => setTimeout(r, 3000));

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
사업내용: ${enrichedOverview.slice(0, 600)}

[초안]
${firstDraft}

===검수 후 최종 출력 (초안과 동일한 구분자 형식 유지)===`;

    // 2차 호출: 검수
    const reviewResult = await geminiCallWithRetry(
      () => model.generateContent(reviewPrompt),
      '검수'
    );
    const text = reviewResult.response.text().trim();

    // 파싱
    const mentMatch = text.match(/---썸네일멘트---([\s\S]*?)---신청자격---/);
    const targetMatch = text.match(/---신청자격---([\s\S]*?)---지원내용---/);
    const amountMatch = text.match(/---지원내용---([\s\S]*?)---신청자격_카드용---/);
    const targetCardMatch = text.match(/---신청자격_카드용---([\s\S]*?)---지원내용_카드용---/);
    const amountCardMatch = text.match(/---지원내용_카드용---([\s\S]*?)---네이버블로그---/);
    const naverMatch = text.match(/---네이버블로그---([\s\S]*?)---티스토리---/);
    const tistoryMatch = text.match(/---티스토리---([\s\S]*?)---블로그스팟---/);
    const blogspotMatch = text.match(/---블로그스팟---([\s\S]*?)$/);

    const fullTarget = targetMatch ? targetMatch[1].trim() : hwpTarget || '공고 원문을 확인해주세요.';
    const fullAmount = amountMatch ? amountMatch[1].trim() : hwpAmount || item.amount || '공고 원문을 확인해주세요.';

    return {
      ment: mentMatch ? mentMatch[1].trim() : `📢 ${item.title.slice(0, 40)}`,
      target: fullTarget,
      amount: fullAmount,
      targetCard: targetCardMatch ? targetCardMatch[1].trim() : fullTarget,
      amountCard: amountCardMatch ? amountCardMatch[1].trim() : fullAmount,
      naver: naverMatch ? naverMatch[1].trim() : '네이버 블로그 글 생성 실패. 공고 원문을 확인해주세요.',
      tistory: tistoryMatch ? tistoryMatch[1].trim() : '티스토리 글 생성 실패. 공고 원문을 확인해주세요.',
      blogspot: blogspotMatch ? blogspotMatch[1].trim() : '블로그스팟 글 생성 실패. 공고 원문을 확인해주세요.',
    };
  } catch (e) {
    log(`Gemini 오류: ${e.message}`);
    const fallbackTarget = item.target || '공고 원문을 확인해주세요.';
    const fallbackAmount = item.amount || '공고 원문을 확인해주세요.';
    return {
      ment: `📢 ${item.title.slice(0, 40)}`,
      target: fallbackTarget,
      amount: fallbackAmount,
      targetCard: fallbackTarget,
      amountCard: fallbackAmount,
      naver: '네이버 블로그 글 생성 실패.',
      tistory: '티스토리 글 생성 실패.',
      blogspot: '블로그스팟 글 생성 실패.',
    };
  }
}

// 카드 1: 썸네일
function makeCard1Html(item, ment) {
  const region = extractRegion(item.title, item.details);
  const cleanTitle = item.title.replace(/^\[[가-힣]+\]\s*/, '');

  // 제목을 핵심 키워드 줄 / 나머지 줄로 분리 (최대 2줄)
  const words = cleanTitle.split(' ');
  let line1 = '', line2 = '';
  if (words.length <= 4) {
    line1 = cleanTitle;
  } else {
    // 앞 3~4단어를 첫 줄, 나머지를 둘째 줄
    const mid = Math.ceil(words.length / 2);
    line1 = words.slice(0, mid).join(' ');
    line2 = words.slice(mid).join(' ');
  }

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body {
  width:1080px; height:1350px;
  background: linear-gradient(160deg, #0d2d6e 0%, #1a4fa0 40%, #0a1e4a 100%);
  display:flex; flex-direction:column;
  font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;
  color:white; position:relative; overflow:hidden;
}
/* 배경 장식 원 */
.deco1 { position:absolute; border-radius:50%; background:rgba(255,255,255,0.04); width:600px; height:600px; top:-180px; right:-180px; }
.deco2 { position:absolute; border-radius:50%; background:rgba(255,255,255,0.04); width:450px; height:450px; bottom:-120px; left:-120px; }
.deco3 { position:absolute; border-radius:50%; background:rgba(100,180,255,0.08); width:300px; height:300px; top:350px; right:-60px; }

/* 상단 바 */
.top-bar {
  position:relative; z-index:2;
  padding:36px 60px 0;
  display:flex; align-items:center; justify-content:space-between;
}
.logo { font-size:28px; font-weight:800; letter-spacing:3px; opacity:0.9; }
.date-tag { font-size:22px; opacity:0.6; }

/* 중앙 메인 */
.main {
  position:relative; z-index:2;
  flex:1; display:flex; flex-direction:column;
  justify-content:center; align-items:center;
  padding:40px 70px;
  gap:36px;
}

/* 지역 태그 */
.region-tag {
  background:rgba(255,255,255,0.15);
  border:1.5px solid rgba(255,255,255,0.35);
  padding:10px 32px; border-radius:50px;
  font-size:26px; font-weight:600; letter-spacing:2px;
}

/* 핵심 사업명 — 크고 임팩트 있게 */
.title-wrap { text-align:center; word-break:keep-all; }
.title-line1 {
  font-size:76px; font-weight:900;
  line-height:1.2;
  text-shadow: 0 4px 20px rgba(0,0,0,0.4);
  display:block;
}
.title-line2 {
  font-size:68px; font-weight:900;
  line-height:1.2;
  color:#7ec8ff;
  text-shadow: 0 4px 20px rgba(0,0,0,0.4);
  display:block;
  margin-top:8px;
}

/* 한 줄 멘트 */
.ment {
  background:rgba(255,255,255,0.12);
  border-left:5px solid #7ec8ff;
  padding:22px 36px; border-radius:14px;
  font-size:30px; line-height:1.65;
  text-align:center; word-break:keep-all;
  width:100%;
}

/* 마감일 */
.deadline {
  background:rgba(255,200,0,0.2);
  border:2px solid rgba(255,200,0,0.55);
  padding:14px 40px; border-radius:50px;
  font-size:28px; font-weight:700; letter-spacing:1px;
}

/* 하단 바 */
.footer {
  position:relative; z-index:2;
  background:rgba(0,0,0,0.25);
  padding:26px 60px;
  display:flex; justify-content:space-between; align-items:center;
  font-size:24px; opacity:0.85;
}
</style></head>
<body>
  <div class="deco1"></div>
  <div class="deco2"></div>
  <div class="deco3"></div>

  <div class="top-bar">
    <span class="logo">🔷 나혼자창업</span>
    <span class="date-tag">${new Date().toLocaleDateString('ko-KR')}</span>
  </div>

  <div class="main">
    <div class="region-tag">📍 ${region} 지원사업</div>

    <div class="title-wrap">
      <span class="title-line1">${line1}</span>
      ${line2 ? `<span class="title-line2">${line2}</span>` : ''}
    </div>

    <div class="ment">${ment}</div>

    ${item.deadline ? `<div class="deadline">⏰ 마감 ${item.deadline}</div>` : ''}
  </div>

  <div class="footer">
    <span>💡 대표님들을 위한 BIZ-TIP</span>
    <span>▶ 공고 원문 확인</span>
  </div>
</body></html>`;
}

// 텍스트를 HTML로 변환 (불릿포인트 줄바꿈 처리)
function formatText(text) {
  return text
    .replace(/•/g, '\n•')           // 불릿 앞에 줄바꿈
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => line.startsWith('•')
      ? `<div style="display:flex;gap:8px;margin-bottom:10px"><span style="flex-shrink:0">•</span><span>${line.slice(1).trim()}</span></div>`
      : `<div style="margin-bottom:10px">${line}</div>`
    )
    .join('');
}

// 카드 2: 사업목적 + 신청자격
function makeCard2Html(item) {
  const overviewLines = formatText((item.overview || '내용을 확인해주세요.').slice(0, 200));
  // 카드용 축약 버전 우선, 없으면 전체 버전 사용
  const targetLines = formatText((item.aiTargetCard || item.aiTarget || item.target || '공고 원문을 확인해주세요.').slice(0, 400));
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
    <span>🔷 나혼자창업</span>
    <span>${new Date().toLocaleDateString('ko-KR')}</span>
  </div>
</body></html>`;
}

// 카드 3: 지원내용
function makeCard3Html(item) {
  // 카드용 축약 버전 우선, 없으면 전체 버전 사용
  const amountText = formatText((item.aiAmountCard || item.aiAmount || item.amount || '공고 원문을 확인해주세요.').slice(0, 400));
  const methodText = formatText((item.aiMethod || item.method || '').slice(0, 200));
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
    <span>🔷 나혼자창업</span>
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
    <span>🔷 나혼자창업</span>
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
    const newItems = await getNewItems(page, 15); // 15페이지까지 수집
    const limitedItems = newItems; // 전체 처리

    if (newItems.length === 0) {
      log('신규 공고 없음. 메일 발송 생략.');
      return;
    }

    log(`신규 공고 ${newItems.length}건 발견. 상세 수집 시작...`);

    // 2. 상세 정보 수집
    const results = [];
    for (let i = 0; i < limitedItems.length; i++) {
      const item = limitedItems[i];
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

    let emailBody = `📬 나혼자창업 신규 지원사업 알림\n`;
    emailBody += `📅 ${new Date().toLocaleDateString('ko-KR')} 기준 ${results.length}건\n`;
    emailBody += `${'='.repeat(50)}\n\n`;

    const allAttachments = [];
    let quotaExceeded = false;      // 한도 초과 여부
    let processedCount = 0;         // 실제 처리 완료된 공고 수
    const skippedItems = [];        // 한도 초과로 못 처리한 공고 목록

    // 4. 각 공고별 처리
    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const region = extractRegion(item.title, item.details);
      const itemDirName = sanitize(item.title.replace(/^\[[가-힣]+\]\s*/, ''));

      // 한도 초과 상태면 나머지는 스킵 목록에만 추가
      if (quotaExceeded) {
        skippedItems.push({ region, title: item.title, url: item.url });
        continue;
      }

      // 지역별 > 사업명별 폴더
      const itemDir = path.join(baseDir, region, itemDirName);
      fs.mkdirSync(itemDir, { recursive: true });

      log(`  [${i + 1}/${results.length}] ${region} / ${item.title}`);

      // Gemini 딜레이 (공고 사이 3초)
      if (i > 0) await new Promise(r => setTimeout(r, 3000));

      // Gemini로 멘트 + 신청자격 + 지원내용 추출 (browser 전달 → HWP Vision 활용)
      let geminiResult;
      try {
        geminiResult = await generateMent(item, browser);
      } catch (e) {
        if (e.isQuotaExceeded) {
          log(`  🚫 Gemini 일일 한도 초과 → 이후 공고(${results.length - i}건) 처리 중단, 메일로 안내`);
          quotaExceeded = true;
          skippedItems.push({ region, title: item.title, url: item.url });
          continue;
        }
        if (e.isFatal) {
          log(`  🚫 치명적 오류로 프로그램 종료`);
          throw e; // main catch로 전달 → 프로그램 종료
        }
        log(`  ⚠️ Gemini 오류: ${e.message}`);
        geminiResult = {
          ment: `📢 ${item.title.slice(0, 40)}`,
          target: item.target || '공고 원문을 확인해주세요.',
          amount: item.amount || '공고 원문을 확인해주세요.',
          naver: '네이버 블로그 글 생성 실패.',
          tistory: '티스토리 글 생성 실패.',
          blogspot: '블로그스팟 글 생성 실패.',
        };
      }

      // Gemini 결과를 item에 반영
      item.aiMent = geminiResult.ment;
      item.aiTarget = geminiResult.target;
      item.aiAmount = geminiResult.amount;
      item.aiTargetCard = geminiResult.targetCard; // 카드용 축약 버전
      item.aiAmountCard = geminiResult.amountCard; // 카드용 축약 버전
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

      processedCount++;
    }

    // 모든 공고 처리 완료 후 → 구글 드라이브에 업로드
    log('📤 구글 드라이브 업로드 시작...');
    const auth = getDriveAuth();
    const drive = google.drive({ version: 'v3', auth });
    const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

    // 오늘 날짜 폴더 생성 (예: 2026-02-23)
    const dateStr = new Date().toISOString().slice(0, 10);
    const dateFolderId = await getOrCreateDriveFolder(drive, dateStr, ROOT_FOLDER_ID);

    const regionDirs = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    const driveLinks = [];
    for (const regionName of regionDirs) {
      try {
        const regionLocalPath = path.join(baseDir, regionName);
        const regionFolderId = await uploadRegionToDrive(drive, regionLocalPath, regionName, dateFolderId);
        const link = `https://drive.google.com/drive/folders/${regionFolderId}`;
        driveLinks.push({ region: regionName, link });
        log(`  ✅ [${regionName}] 드라이브 업로드 완료`);
      } catch (e) {
        log(`  ⚠️ [${regionName}] 드라이브 업로드 실패: ${e.message}`);
      }
    }

    // 드라이브 링크를 이메일 본문에 추가
    const dateFolderLink = `https://drive.google.com/drive/folders/${dateFolderId}`;
    emailBody += `\n${'='.repeat(50)}\n`;
    emailBody += `📁 구글 드라이브 전체 폴더:\n${dateFolderLink}\n\n`;
    emailBody += `📂 지역별 폴더 링크:\n`;
    driveLinks.forEach(({ region, link }) => {
      emailBody += `  • [${region}] ${link}\n`;
    });
    emailBody += `${'='.repeat(50)}\n`;

    // 한도 초과로 미처리된 공고 안내 추가
    if (quotaExceeded && skippedItems.length > 0) {
      emailBody += `\n${'⚠️'.repeat(10)}\n`;
      emailBody += `🚫 Gemini API 일일 한도 초과로 아래 ${skippedItems.length}건은 처리하지 못했습니다.\n`;
      emailBody += `📌 처리 완료: ${processedCount}건 / 전체 신규: ${results.length}건\n`;
      emailBody += `🔄 내일 새벽 자동실행 시 나머지 공고는 이미 수집된 것으로 처리되어 재전송되지 않습니다.\n`;
      emailBody += `👉 아래 공고는 직접 bizinfo.go.kr에서 확인해주세요.\n\n`;
      skippedItems.forEach((s, idx) => {
        emailBody += `[미처리 ${idx + 1}] [${s.region}] ${s.title}\n`;
        emailBody += `🔗 ${s.url}\n\n`;
      });
      emailBody += `${'⚠️'.repeat(10)}\n`;
      log(`📧 한도 초과 안내 포함하여 메일 발송 (처리: ${processedCount}건, 미처리: ${skippedItems.length}건)`);
    }

    // 5. DB 업데이트 (처리 완료된 공고만 저장 - 미처리 공고는 내일 다시 수집)
    const db = loadDB();
    const processedItems = quotaExceeded
      ? results.filter(item => !skippedItems.some(s => s.url === item.url))
      : results;
    processedItems.forEach(item => {
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
      from: `"나혼자창업 자동수집" <${process.env.GMAIL_USER}>`,
      to: TO_EMAIL,
      subject: `📋 나혼자창업 신규 공고 ${results.length}건 - ${new Date().toLocaleDateString('ko-KR')}`,
      text: emailBody,
    });

    // 최종 Gemini 호출 통계
    const totalCalls = geminiStats.total;
    const totalMinutes = geminiStats.callTimes.length >= 2
      ? (geminiStats.callTimes[geminiStats.callTimes.length - 1].time - geminiStats.callTimes[0].time) / 60000
      : 1;
    const avgRpm = totalMinutes > 0 ? (totalCalls / totalMinutes).toFixed(1) : totalCalls;
    log(`📊 Gemini 최종 통계 | 전체 호출: ${totalCalls}회 | 평균 분당 ${avgRpm}회`);
    emailBody += `\n${'─'.repeat(50)}\n`;
    emailBody += `📊 Gemini 통계: 전체 ${totalCalls}회 호출 / 평균 분당 ${avgRpm}회\n`;

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
