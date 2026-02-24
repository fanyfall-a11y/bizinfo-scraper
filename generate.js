require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');

// 환경변수로 URL 받기 (쉼표로 구분)
const INPUT_URLS = (process.env.TARGET_URLS || '').split(',').map(u => u.trim()).filter(Boolean);

const DB_FILE = path.join(__dirname, 'collected_ids.json');
const LOG_FILE = path.join(__dirname, 'auto_log.txt');

const geminiStats = { total: 0, callTimes: [] };

function countGeminiCall(label) {
  geminiStats.total++;
  geminiStats.callTimes.push({ time: Date.now(), label });
}

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

// 구글 드라이브 인증 (OAuth)
function getDriveAuth() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const tokens = JSON.parse(process.env.GOOGLE_OAUTH_TOKENS);
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

async function getOrCreateDriveFolder(drive, name, parentId) {
  const res = await drive.files.list({
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`,
    fields: 'files(id, name)',
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const folder = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id',
    supportsAllDrives: true,
  });
  return folder.data.id;
}

async function uploadFileToDrive(drive, filePath, fileName, parentId) {
  const fileStream = fs.createReadStream(filePath);
  const res = await drive.files.create({
    requestBody: { name: fileName, parents: [parentId] },
    media: { body: fileStream },
    fields: 'id, webViewLink',
    supportsAllDrives: true,
  });
  return res.data;
}

async function uploadItemToDrive(drive, itemLocalPath, itemName, regionFolderId) {
  const itemFolderId = await getOrCreateDriveFolder(drive, itemName, regionFolderId);
  const files = fs.readdirSync(itemLocalPath).filter(f => fs.statSync(path.join(itemLocalPath, f)).isFile());
  for (const fileName of files) {
    await uploadFileToDrive(drive, path.join(itemLocalPath, fileName), fileName, itemFolderId);
  }
  return itemFolderId;
}

// 상세 페이지 스크래핑
async function scrapeDetail(page, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    return await page.evaluate(() => {
      let title = '';
      for (const h of document.querySelectorAll('h2, h3, h4')) {
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
      const overview = details.find(d => d.label.includes('사업개요'));
      const target = details.find(d => d.label.includes('지원대상') || d.label.includes('신청자격'));
      const amount = details.find(d => d.label.includes('지원금액') || d.label.includes('지원규모') || d.label.includes('지원내용'));
      const method = details.find(d => d.label.includes('신청방법') || d.label.includes('사업신청'));
      const period = details.find(d => d.label.includes('신청기간') || d.label.includes('접수기간'));
      const contact = details.find(d => d.label.includes('문의처') || d.label.includes('담당'));
      const organ = details.find(d => d.label.includes('주관') || d.label.includes('소관부처') || d.label.includes('지자체'));
      const bodyText = document.body.innerText;
      const deadlineMatch = bodyText.match(/(?:신청기간|접수기간|마감)[^\n]*?(\d{4}[.\-년]\s*\d{1,2}[.\-월]\s*\d{1,2})/);
      const deadline = deadlineMatch ? deadlineMatch[1].replace(/\s/g, '').replace(/년|월/g, '.').replace(/일/g, '') : '';
      const iframeSrc = document.querySelector('iframe')?.src || '';
      return {
        title, details,
        overview: overview?.value || '',
        target: target?.value || '',
        amount: amount?.value || '',
        method: method?.value || '',
        period: period?.value || '',
        contact: contact?.value || '',
        organ: organ?.value || '',
        deadline, iframeSrc
      };
    });
  } catch {
    log(`접속 실패: ${url}`);
    return null;
  }
}

async function geminiCallWithRetry(fn, label) {
  const delays = [60000, 120000, 600000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const result = await fn();
      countGeminiCall(label);
      log(`  📊 Gemini [${label}] 완료 | 전체 ${geminiStats.total}회`);
      return result;
    } catch (e) {
      const is429 = e.message && (e.message.includes('429') || e.message.includes('quota') || e.message.includes('Too Many'));
      if (is429 && attempt < delays.length) {
        log(`  ⚠️ [${label}] 429 오류 → ${delays[attempt]/1000}초 대기 후 재시도`);
        await new Promise(r => setTimeout(r, delays[attempt]));
      } else throw e;
    }
  }
}

async function extractHwpContent(iframeSrc, title, browser) {
  try {
    log('  📄 HWP 뷰어 스크린샷 캡처 중...');
    const viewerPage = await browser.newPage();
    await viewerPage.setViewport({ width: 1200, height: 1400 });
    await viewerPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');
    await viewerPage.goto(iframeSrc, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));
    const totalPages = await viewerPage.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/\/\s*(\d+)/);
      return m ? Math.min(parseInt(m[1]), 6) : 3;
    });
    const screenshots = [];
    for (let p = 1; p <= totalPages; p++) {
      if (p > 1) {
        await viewerPage.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, a'));
          const nextBtn = btns.find(b => b.title?.includes('다음') || b.className?.includes('next') || b.getAttribute('aria-label')?.includes('next') || b.innerText?.trim() === '>');
          if (nextBtn) nextBtn.click();
        });
        await new Promise(r => setTimeout(r, 3000));
      }
      const imgPath = `/tmp/hwp_page_${p}.png`;
      await viewerPage.screenshot({ path: imgPath, fullPage: false });
      screenshots.push(imgPath);
    }
    await viewerPage.close();
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const parts = [{ text: `다음은 지원사업 공고문 이미지(${totalPages}페이지)입니다. 아래 항목만 정확하게 추출해주세요.\n\n1. 지원대상(신청자격)\n2. 지원내용\n3. 신청방법\n\n---지원대상---\n(내용)\n---지원내용---\n(내용)\n---신청방법---\n(내용)` }];
    for (const imgPath of screenshots) {
      const imgData = fs.readFileSync(imgPath);
      parts.push({ inlineData: { mimeType: 'image/png', data: imgData.toString('base64') } });
    }
    const hwpResult = await geminiCallWithRetry(() => model.generateContent(parts), 'HWP Vision');
    const hwpText = hwpResult.response.text().trim();
    return {
      hwpTarget: hwpText.match(/---지원대상---([\s\S]*?)---지원내용---/)?.[1]?.trim() || '',
      hwpAmount: hwpText.match(/---지원내용---([\s\S]*?)---신청방법---/)?.[1]?.trim() || '',
      hwpMethod: hwpText.match(/---신청방법---([\s\S]*?)$/)?.[1]?.trim() || '',
    };
  } catch (e) {
    log(`  ❌ HWP 추출 실패: ${e.message}`);
    return { hwpTarget: '', hwpAmount: '', hwpMethod: '' };
  }
}

async function generateContent(item, browser) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const title = item.title;
  const period = item.period || item.deadline || '미상';
  const contact = item.contact || '공고 원문 확인';

  let hwpTarget = '', hwpAmount = '', hwpMethod = '';
  if (item.iframeSrc && browser) {
    const hwp = await extractHwpContent(item.iframeSrc, title, browser);
    hwpTarget = hwp.hwpTarget;
    hwpAmount = hwp.hwpAmount;
    hwpMethod = hwp.hwpMethod;
    await new Promise(r => setTimeout(r, 3000));
  }

  const enrichedOverview = [
    (item.overview || '').slice(0, 600),
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
(핵심 제한 조건 최대 3가지만. 불릿포인트(•)로. 마지막에 "• 자세한 조건은 공고 원문 확인" 추가)

---지원내용_카드용---
(핵심 3가지만. 불릿포인트(•)로. 마지막에 "• 자세한 내용은 공고 원문 확인" 추가)

---네이버블로그---
[작성 지침]
- 1500~2000자
- 친근하지만 전문적인 경어체
- 소제목(##) 사용
- 마지막에 "공감과 댓글은 큰 힘이 됩니다 😊" 추가
- AI 말투 절대 금지
- 키워드: ${title.replace(/\[[가-힣]+\]/g, '').trim().split(' ').slice(0, 3).join(', ')}
제목:
본문:

---티스토리---
[작성 지침]
- 1000~1500자
- 정보성 경어체, 담백하고 군더더기 없는 문장
- SEO 최적화, 소제목(##) 사용
- AI 말투 절대 금지
제목:
본문:

---블로그스팟---
[작성 지침]
- 800~1200자
- 간결하고 핵심만 담은 경어체
- 해시태그 5개 포함
- AI 말투 절대 금지
제목:
본문:

---인스타그램---
[작성 지침]
- 전체 300~500자
- 첫 1~2줄이 핵심: 스크롤 멈추게 하는 후킹 문장 (이모지 1~2개)
- 공백 줄로 단락 구분
- 핵심 정보만: 대상 / 지원내용 / 신청기간
- 마지막 줄: "📎 자세한 내용은 프로필 링크 참고"
- 해시태그 15개: 본문과 공백 한 줄 분리
- 이모지는 줄 앞에만, 과하게 쓰지 말 것
- AI 말투 절대 금지
본문:`;

  const result = await geminiCallWithRetry(() => model.generateContent(prompt), '초안 생성');
  const firstDraft = result.response.text().trim();
  await new Promise(r => setTimeout(r, 3000));

  const reviewPrompt = `다음은 지원사업 공고를 기반으로 작성된 콘텐츠 초안입니다.
아래 검수 기준에 맞게 문제가 있는 부분만 수정해서 최종본을 출력해줘.

[검수 기준]
1. AI 말투 제거: "안녕하세요!", "오늘은 ~에 대해 알아보겠습니다" 등 → 자연스러운 문장으로 교체
2. 할루시네이션 방지: 공고 원문에 없는 수치나 정보 → 삭제하고 "공고 원문을 확인해주세요"로 대체
3. 중복 콘텐츠 방지: 네이버/티스토리/블로그스팟 글이 너무 비슷하면 도입부와 마무리 문장을 다르게 수정
4. 인스타그램: 첫 줄 후킹이 약하면 더 임팩트 있게 수정, 해시태그 15개 확인
5. 공고명, 신청기간, 지원내용은 원문 그대로 유지 (변경 금지)

[공고 원문 핵심]
공고명: ${title}
신청기간: ${period}
사업내용: ${enrichedOverview.slice(0, 600)}

[초안]
${firstDraft}

===검수 후 최종 출력 (초안과 동일한 구분자 형식 유지)===`;

  const reviewResult = await geminiCallWithRetry(() => model.generateContent(reviewPrompt), '검수');
  const text = reviewResult.response.text().trim();

  const mentMatch = text.match(/---썸네일멘트---([\s\S]*?)---신청자격---/);
  const targetMatch = text.match(/---신청자격---([\s\S]*?)---지원내용---/);
  const amountMatch = text.match(/---지원내용---([\s\S]*?)---신청자격_카드용---/);
  const targetCardMatch = text.match(/---신청자격_카드용---([\s\S]*?)---지원내용_카드용---/);
  const amountCardMatch = text.match(/---지원내용_카드용---([\s\S]*?)---네이버블로그---/);
  const naverMatch = text.match(/---네이버블로그---([\s\S]*?)---티스토리---/);
  const tistoryMatch = text.match(/---티스토리---([\s\S]*?)---블로그스팟---/);
  const blogspotMatch = text.match(/---블로그스팟---([\s\S]*?)---인스타그램---/);
  const instaMatch = text.match(/---인스타그램---([\s\S]*?)$/);

  const fullTarget = targetMatch?.[1]?.trim() || hwpTarget || '공고 원문을 확인해주세요.';
  const fullAmount = amountMatch?.[1]?.trim() || hwpAmount || item.amount || '공고 원문을 확인해주세요.';

  return {
    ment: mentMatch?.[1]?.trim() || `📢 ${title.slice(0, 40)}`,
    target: fullTarget,
    amount: fullAmount,
    targetCard: targetCardMatch?.[1]?.trim() || fullTarget,
    amountCard: amountCardMatch?.[1]?.trim() || fullAmount,
    naver: naverMatch?.[1]?.trim() || '생성 실패.',
    tistory: tistoryMatch?.[1]?.trim() || '생성 실패.',
    blogspot: blogspotMatch?.[1]?.trim() || '생성 실패.',
    insta: instaMatch?.[1]?.trim() || '생성 실패.',
  };
}

function formatText(text) {
  return text.replace(/•/g, '\n•').split('\n').map(l => l.trim()).filter(l => l.length > 0)
    .map(l => l.startsWith('•')
      ? `<div style="display:flex;gap:8px;margin-bottom:10px"><span>•</span><span>${l.slice(1).trim()}</span></div>`
      : `<div style="margin-bottom:10px">${l}</div>`).join('');
}

function makeCard1Html(item, ment) {
  const region = extractRegion(item.title, item.details);
  const cleanTitle = item.title.replace(/^\[[가-힣]+\]\s*/, '');
  const words = cleanTitle.split(' ');
  let line1 = '', line2 = '';
  if (words.length <= 4) { line1 = cleanTitle; }
  else { const mid = Math.ceil(words.length / 2); line1 = words.slice(0, mid).join(' '); line2 = words.slice(mid).join(' '); }
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box;}body{width:1080px;height:1350px;background:linear-gradient(160deg,#0d2d6e 0%,#1a4fa0 40%,#0a1e4a 100%);display:flex;flex-direction:column;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:white;position:relative;overflow:hidden;}.deco1{position:absolute;border-radius:50%;background:rgba(255,255,255,0.04);width:600px;height:600px;top:-180px;right:-180px;}.deco2{position:absolute;border-radius:50%;background:rgba(255,255,255,0.04);width:450px;height:450px;bottom:-120px;left:-120px;}.top-bar{position:relative;z-index:2;padding:36px 60px 0;display:flex;align-items:center;justify-content:space-between;}.logo{font-size:28px;font-weight:800;letter-spacing:3px;opacity:0.9;}.date-tag{font-size:22px;opacity:0.6;}.main{position:relative;z-index:2;flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:40px 70px;gap:36px;}.region-tag{background:rgba(255,255,255,0.15);border:1.5px solid rgba(255,255,255,0.35);padding:10px 32px;border-radius:50px;font-size:26px;font-weight:600;letter-spacing:2px;}.title-wrap{text-align:center;word-break:keep-all;}.title-line1{font-size:76px;font-weight:900;line-height:1.2;text-shadow:0 4px 20px rgba(0,0,0,0.4);display:block;}.title-line2{font-size:68px;font-weight:900;line-height:1.2;color:#7ec8ff;display:block;margin-top:8px;}.ment{background:rgba(255,255,255,0.12);border-left:5px solid #7ec8ff;padding:22px 36px;border-radius:14px;font-size:30px;line-height:1.65;text-align:center;word-break:keep-all;width:100%;}.deadline{background:rgba(255,200,0,0.2);border:2px solid rgba(255,200,0,0.55);padding:14px 40px;border-radius:50px;font-size:28px;font-weight:700;}.footer{position:relative;z-index:2;background:rgba(0,0,0,0.25);padding:26px 60px;display:flex;justify-content:space-between;align-items:center;font-size:24px;opacity:0.85;}</style></head><body><div class="deco1"></div><div class="deco2"></div><div class="top-bar"><span class="logo">🔷 나혼자창업</span><span class="date-tag">${new Date().toLocaleDateString('ko-KR')}</span></div><div class="main"><div class="region-tag">📍 ${region} 지원사업</div><div class="title-wrap"><span class="title-line1">${line1}</span>${line2 ? `<span class="title-line2">${line2}</span>` : ''}</div><div class="ment">${ment}</div>${item.deadline ? `<div class="deadline">⏰ 마감 ${item.deadline}</div>` : ''}</div><div class="footer"><span>💡 대표님들을 위한 BIZ-TIP</span><span>▶ 공고 원문 확인</span></div></body></html>`;
}

function makeCard2Html(item) {
  const overviewLines = formatText((item.overview || '내용을 확인해주세요.').slice(0, 200));
  const targetLines = formatText((item.aiTargetCard || item.aiTarget || item.target || '공고 원문을 확인해주세요.').slice(0, 400));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box;}body{width:1080px;height:1350px;background:#f0f5ff;display:flex;flex-direction:column;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;}.top-bar{background:linear-gradient(90deg,#1a4fa0,#2563c7);padding:24px 60px;color:white;font-size:26px;font-weight:600;letter-spacing:2px;}.card-inner{flex:1;background:white;margin:30px 40px;border-radius:24px;padding:50px;display:flex;flex-direction:column;gap:40px;box-shadow:0 8px 32px rgba(37,99,199,0.1);}.section-tag{display:inline-block;background:#2563c7;color:white;padding:10px 24px;border-radius:20px;font-size:26px;font-weight:700;margin-bottom:20px;}.section-content{font-size:28px;line-height:1.8;color:#333;word-break:keep-all;}.divider{height:2px;background:#e8f0fe;}.footer{background:linear-gradient(90deg,#1a4fa0,#2563c7);padding:20px 60px;color:white;display:flex;justify-content:space-between;font-size:22px;}</style></head><body><div class="top-bar">💡 대표님들을 위한 BIZ-TIP</div><div class="card-inner"><div><div class="section-tag">사업목적</div><div class="section-content">${overviewLines}</div></div><div class="divider"></div><div><div class="section-tag">신청자격</div><div class="section-content">${targetLines}</div></div></div><div class="footer"><span>🔷 나혼자창업</span><span>${new Date().toLocaleDateString('ko-KR')}</span></div></body></html>`;
}

function makeCard3Html(item) {
  const amountText = formatText((item.aiAmountCard || item.aiAmount || item.amount || '공고 원문을 확인해주세요.').slice(0, 400));
  const methodText = formatText((item.aiMethod || item.method || '').slice(0, 200));
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box;}body{width:1080px;height:1350px;background:#f0f5ff;display:flex;flex-direction:column;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;}.top-bar{background:linear-gradient(90deg,#1a4fa0,#2563c7);padding:24px 60px;color:white;font-size:26px;font-weight:600;}.card-inner{flex:1;background:white;margin:30px 40px;border-radius:24px;padding:50px;display:flex;flex-direction:column;gap:30px;box-shadow:0 8px 32px rgba(37,99,199,0.1);}.section-tag{display:inline-block;background:#2563c7;color:white;padding:10px 24px;border-radius:20px;font-size:26px;font-weight:700;margin-bottom:20px;}.amount-box{background:#e8f0fe;border-radius:16px;padding:30px;font-size:28px;line-height:1.8;color:#1a3a7a;word-break:keep-all;}.method-box{background:#f8faff;border:2px solid #d0e0ff;border-radius:16px;padding:24px;font-size:26px;line-height:1.7;color:#333;}.footer{background:linear-gradient(90deg,#1a4fa0,#2563c7);padding:20px 60px;color:white;display:flex;justify-content:space-between;font-size:22px;}</style></head><body><div class="top-bar">💡 대표님들을 위한 BIZ-TIP</div><div class="card-inner"><div><div class="section-tag">지원내용</div><div class="amount-box">${amountText}</div></div>${methodText ? `<div><div class="section-tag">신청방법</div><div class="method-box">${methodText}</div></div>` : ''}</div><div class="footer"><span>🔷 나혼자창업</span><span>${new Date().toLocaleDateString('ko-KR')}</span></div></body></html>`;
}

function makeCard4Html(item) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box;}body{width:1080px;height:1350px;background:linear-gradient(160deg,#1a4fa0 0%,#2563c7 50%,#1e3a7a 100%);display:flex;flex-direction:column;font-family:'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:white;}.top-bar{background:rgba(255,255,255,0.15);padding:24px 60px;font-size:26px;font-weight:600;}.main{flex:1;display:flex;flex-direction:column;justify-content:center;padding:60px;gap:30px;}.info-row{background:rgba(255,255,255,0.12);border-radius:16px;padding:28px 36px;display:flex;flex-direction:column;gap:10px;}.info-label{font-size:24px;opacity:0.7;font-weight:600;}.info-value{font-size:30px;font-weight:700;word-break:keep-all;}.cta{background:rgba(255,255,255,0.2);border:2px solid rgba(255,255,255,0.5);border-radius:16px;padding:28px 36px;text-align:center;font-size:32px;font-weight:800;}.footer{background:rgba(0,0,0,0.2);padding:24px 60px;display:flex;justify-content:space-between;font-size:22px;opacity:0.8;}</style></head><body><div class="top-bar">💡 대표님들을 위한 BIZ-TIP</div><div class="main"><div class="info-row"><div class="info-label">📅 신청기간</div><div class="info-value">${item.period || item.deadline || '공고 원문 확인'}</div></div>${item.organ ? `<div class="info-row"><div class="info-label">🏛️ 주관기관</div><div class="info-value">${item.organ}</div></div>` : ''}<div class="info-row"><div class="info-label">📞 문의처</div><div class="info-value">${item.contact || '공고 원문 확인'}</div></div><div class="cta">🔗 지금 바로 신청하세요!</div></div><div class="footer"><span>🔷 나혼자창업</span><span>${new Date().toLocaleDateString('ko-KR')}</span></div></body></html>`;
}

async function htmlToImage(html, outputPath, browser) {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: outputPath, type: 'png', clip: { x: 0, y: 0, width: 1080, height: 1350 } });
  await page.close();
}

async function main() {
  log('=== 콘텐츠 생성 시작 ===');

  if (INPUT_URLS.length === 0) {
    log('❌ TARGET_URLS 환경변수가 없습니다. 종료.');
    process.exit(1);
  }

  log(`📋 처리할 공고: ${INPUT_URLS.length}건`);
  INPUT_URLS.forEach((url, i) => log(`  ${i+1}. ${url}`));

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const baseDir = path.join(__dirname, 'output', `selected_${timestamp}`);
    fs.mkdirSync(baseDir, { recursive: true });

    const driveAuth = getDriveAuth();
    const drive = google.drive({ version: 'v3', auth: driveAuth });
    const ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const dateStr = new Date().toISOString().slice(0, 10);
    const dateFolderId = await getOrCreateDriveFolder(drive, dateStr, ROOT_FOLDER_ID);

    const driveLinks = [];
    const db = loadDB();

    for (let i = 0; i < INPUT_URLS.length; i++) {
      const url = INPUT_URLS[i];
      log(`\n[${i+1}/${INPUT_URLS.length}] 처리 중: ${url}`);

      const detail = await scrapeDetail(page, url);
      if (!detail) { log('  ❌ 상세 정보 수집 실패, 스킵'); continue; }
      detail.url = url;

      const region = extractRegion(detail.title, detail.details);
      const itemDirName = sanitize(detail.title.replace(/^\[[가-힣]+\]\s*/, ''));
      const itemDir = path.join(baseDir, region, itemDirName);
      fs.mkdirSync(itemDir, { recursive: true });

      if (i > 0) await new Promise(r => setTimeout(r, 3000));

      // Gemini 콘텐츠 생성
      const geminiResult = await generateContent(detail, browser);
      detail.aiMent = geminiResult.ment;
      detail.aiTarget = geminiResult.target;
      detail.aiAmount = geminiResult.amount;
      detail.aiTargetCard = geminiResult.targetCard;
      detail.aiAmountCard = geminiResult.amountCard;
      detail.aiNaver = geminiResult.naver;
      detail.aiTistory = geminiResult.tistory;
      detail.aiBlogspot = geminiResult.blogspot;
      detail.aiInsta = geminiResult.insta;

      // 카드 4장 생성
      try {
        await htmlToImage(makeCard1Html(detail, detail.aiMent), path.join(itemDir, '01_썸네일.png'), browser);
        await htmlToImage(makeCard2Html(detail), path.join(itemDir, '02_사업목적_신청자격.png'), browser);
        await htmlToImage(makeCard3Html(detail), path.join(itemDir, '03_지원내용.png'), browser);
        await htmlToImage(makeCard4Html(detail), path.join(itemDir, '04_신청정보.png'), browser);
        log(`  ✅ 카드 4장 생성 완료`);
      } catch (e) { log(`  ⚠️ 이미지 생성 실패: ${e.message}`); }

      // 파일 저장
      const mentContent = `[${detail.title}]\n\n📌 핵심 멘트:\n${detail.aiMent}\n\n👥 신청자격:\n${detail.aiTarget}\n\n💰 지원내용:\n${detail.aiAmount}\n\n📅 신청기간:\n${detail.period || detail.deadline || '없음'}\n\n📞 문의:\n${detail.contact || '없음'}\n\n🔗 링크:\n${url}`;
      fs.writeFileSync(path.join(itemDir, '00_멘트_요약.txt'), mentContent, 'utf8');
      fs.writeFileSync(path.join(itemDir, '05_네이버블로그.txt'), detail.aiNaver, 'utf8');
      fs.writeFileSync(path.join(itemDir, '06_티스토리.txt'), detail.aiTistory, 'utf8');
      fs.writeFileSync(path.join(itemDir, '07_블로그스팟.txt'), detail.aiBlogspot, 'utf8');
      fs.writeFileSync(path.join(itemDir, '08_인스타그램.txt'), detail.aiInsta, 'utf8');

      // 드라이브 업로드
      try {
        const regionFolderId = await getOrCreateDriveFolder(drive, region, dateFolderId);
        const itemFolderId = await uploadItemToDrive(drive, itemDir, itemDirName, regionFolderId);
        const link = `https://drive.google.com/drive/folders/${itemFolderId}`;
        driveLinks.push({ title: detail.title, region, link });
        log(`  ✅ 드라이브 업로드 완료`);
      } catch (e) { log(`  ⚠️ 드라이브 업로드 실패: ${e.message}`); }

      // DB 기록
      const id = extractId(url);
      if (id) db[id] = { title: detail.title, collectedAt: new Date().toISOString() };
    }

    saveDB(db);

    // 완료 이메일 발송
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });

    const TO_EMAIL = process.env.TO_EMAIL || 'nagairams1@gmail.com';
    const dateFolderLink = `https://drive.google.com/drive/folders/${dateFolderId}`;
    let emailBody = `✅ 콘텐츠 생성 완료! ${driveLinks.length}건\n\n`;
    emailBody += `📁 전체 폴더: ${dateFolderLink}\n\n`;
    driveLinks.forEach(({ title, region, link }) => {
      emailBody += `• [${region}] ${title}\n  ${link}\n\n`;
    });

    await transporter.sendMail({
      from: `"나혼자창업 자동수집" <${process.env.GMAIL_USER}>`,
      to: TO_EMAIL,
      subject: `✅ 콘텐츠 생성 완료 ${driveLinks.length}건 - ${new Date().toLocaleDateString('ko-KR')}`,
      text: emailBody,
    });

    log(`📧 완료 이메일 발송 → ${TO_EMAIL}`);
    log(`✅ 전체 완료! ${driveLinks.length}건 처리`);

  } catch (err) {
    log(`오류: ${err.message}`);
  } finally {
    await browser.close();
  }

  log('=== 콘텐츠 생성 종료 ===');
}

main();
