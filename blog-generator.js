require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const puppeteer = require('puppeteer');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(r => rl.question(q, r)); }

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// =====================
// 카드뉴스 HTML 템플릿 (액자 카드 스타일)
// =====================
function makeCardHTML(cardType, data) {
  const { title, org, agency, period, region, overview, target, support, method, contact, cardNum, totalCards } = data;

  const shortTitle = title.replace(/\[.+?\]\s*/g, '').replace(/\s*수정\s*공고/, '').trim();
  const truncate = (str, len) => str && str.length > len ? str.slice(0, len) + '…' : (str || '');

  // 카드별 배경 색상 (예시 이미지처럼 단색 배경)
  const themes = {
    cover:    { bg: '#3D5AFE', card: '#FFFFFF', title: '#1A237E', badge: '#3D5AFE', badgeText: '#FFFFFF', clip: '#1A237E' },
    overview: { bg: '#00897B', card: '#FFFFFF', title: '#004D40', badge: '#00897B', badgeText: '#FFFFFF', clip: '#004D40' },
    target:   { bg: '#7B1FA2', card: '#FFFFFF', title: '#4A148C', badge: '#7B1FA2', badgeText: '#FFFFFF', clip: '#4A148C' },
    support:  { bg: '#E53935', card: '#FFFFFF', title: '#B71C1C', badge: '#E53935', badgeText: '#FFFFFF', clip: '#B71C1C' },
    apply:    { bg: '#2E7D32', card: '#FFFFFF', title: '#1B5E20', badge: '#2E7D32', badgeText: '#FFFFFF', clip: '#1B5E20' },
  };
  const t = themes[cardType];

  // 카드별 라벨
  const labels = {
    cover:    { label: '지원사업 안내' },
    overview: { label: '사업 개요' },
    target:   { label: '지원 대상' },
    support:  { label: '지원 내용' },
    apply:    { label: '신청 방법' },
  };
  const l = labels[cardType];

  // 내용 정제
  const cleanText = (str) => (str || '').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
  const splitLines = (str, maxLen = 14) => {
    const chars = cleanText(str).split('');
    const lines = [];
    let cur = '';
    for (const c of chars) {
      cur += c;
      if (cur.length >= maxLen) { lines.push(cur.trim()); cur = ''; }
      if (lines.length >= 3) break;
    }
    if (cur.trim() && lines.length < 3) lines.push(cur.trim());
    return lines;
  };
  const splitLinesByWord = (str, maxLen = 22) => {
    const words = cleanText(str).split(' ');
    const lines = [];
    let cur = '';
    for (const w of words) {
      if ((cur + w).length > maxLen) { if (cur) lines.push(cur.trim()); cur = w + ' '; }
      else cur += w + ' ';
      if (lines.length >= 5) break;
    }
    if (cur.trim() && lines.length < 5) lines.push(cur.trim());
    return lines;
  };

  // 공통 구글 폰트 import
  const fontLink = `<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;700;900&display=swap" rel="stylesheet">`;

  // 공통 클립 SVG (상단 고리 장식)
  const clips = (clipColor) => `
    <div style="position:absolute;top:-18px;left:50%;transform:translateX(-50%);display:flex;gap:200px;">
      <div style="width:30px;height:50px;background:${clipColor};border-radius:4px;box-shadow:2px 2px 6px rgba(0,0,0,0.3);"></div>
      <div style="width:30px;height:50px;background:${clipColor};border-radius:4px;box-shadow:2px 2px 6px rgba(0,0,0,0.3);"></div>
    </div>
    <div style="position:absolute;top:-8px;left:50%;transform:translateX(-50%);display:flex;gap:200px;">
      <div style="width:18px;height:18px;border-radius:50%;background:${clipColor};opacity:0.7;margin-left:6px;"></div>
      <div style="width:18px;height:18px;border-radius:50%;background:${clipColor};opacity:0.7;margin-left:6px;"></div>
    </div>`;

  // 공통 헤더/푸터 HTML
  const header = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">
      <div style="background:${t.badge};color:${t.badgeText};padding:8px 18px;border-radius:30px;font-size:22px;font-weight:700;letter-spacing:1px;">
        ${l.icon} ${l.label}
      </div>
      <div style="color:rgba(255,255,255,0.5);font-size:20px;font-weight:500;">
        ${cardNum} / ${totalCards}
      </div>
    </div>`;

  // 공통 카드 래퍼 (액자 스타일)
  const makeFrame = (bgColor, clipColor, cardContent, pageNum, totalNum) => `
    <!DOCTYPE html><html><head>
      <meta charset="UTF-8">
      ${fontLink}
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { width: 1080px; height: 1080px; overflow: hidden; background: ${bgColor};
               font-family: 'Noto Sans KR', sans-serif; display: flex;
               align-items: center; justify-content: center; }
        .frame-wrap { position: relative; width: 820px; }
        .card {
          background: #ffffff;
          border-radius: 32px;
          padding: 64px 72px 56px;
          box-shadow: 0 20px 60px rgba(0,0,0,0.25);
          min-height: 640px;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
        }
        .page-num {
          position: absolute;
          bottom: -52px;
          left: 50%;
          transform: translateX(-50%);
          color: rgba(255,255,255,0.6);
          font-size: 22px;
          font-weight: 500;
          white-space: nowrap;
        }
        .site-tag {
          position: absolute;
          bottom: -90px;
          left: 50%;
          transform: translateX(-50%);
          color: rgba(255,255,255,0.45);
          font-size: 18px;
          white-space: nowrap;
        }
      </style>
    </head><body>
    <div class="frame-wrap">
      ${clips(clipColor)}
      <div class="card">
        ${cardContent}
      </div>
      <div class="page-num">${pageNum} / ${totalNum}</div>
      <div class="site-tag">지원캐쳐</div>
    </div>
    </body></html>`;

  // ── 1. 표지 ──
  if (cardType === 'cover') {
    const titleLines = splitLines(shortTitle, 13);
    const content = `
      <div style="background:${t.bg};color:white;padding:10px 28px;border-radius:30px;font-size:22px;font-weight:700;margin-bottom:32px;letter-spacing:1px;">
        지원사업 안내
      </div>
      ${titleLines.map(line => `
        <div style="color:${t.title};font-size:${titleLines.length === 1 ? 88 : titleLines.length === 2 ? 80 : 68}px;font-weight:900;line-height:1.2;word-break:keep-all;">${line}</div>
      `).join('')}
      <div style="margin-top:36px;background:${t.bg};color:white;padding:14px 40px;border-radius:40px;font-size:24px;font-weight:600;display:inline-block;">
        ${truncate(shortTitle, 22)} 알아보기
      </div>`;
    return makeFrame(t.bg, t.clip, content, cardNum, totalCards);
  }

  // ── 2. 사업 개요 ──
  if (cardType === 'overview') {
    const overviewLines = splitLinesByWord(overview, 26);
    const content = `
      <div style="background:${t.bg};color:white;padding:10px 28px;border-radius:30px;font-size:22px;font-weight:700;margin-bottom:28px;">
        📌 사업 개요
      </div>
      <div style="text-align:left;width:100%;">
        ${org ? `<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;"><span style="background:${t.bg};color:white;padding:4px 14px;border-radius:20px;font-size:18px;font-weight:700;flex-shrink:0;">주관</span><span style="color:#333;font-size:20px;font-weight:500;">${org}</span></div>` : ''}
        ${period ? `<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;"><span style="background:${t.bg};color:white;padding:4px 14px;border-radius:20px;font-size:18px;font-weight:700;flex-shrink:0;">기간</span><span style="color:${t.bg};font-size:20px;font-weight:700;">${period}</span></div>` : ''}
        <div style="border-top:2px solid #eee;padding-top:18px;">
          ${overviewLines.slice(0, 5).map(line => `<div style="color:#444;font-size:20px;line-height:1.7;margin-bottom:2px;">${line}</div>`).join('')}
        </div>
      </div>`;
    return makeFrame(t.bg, t.clip, content, cardNum, totalCards);
  }

  // ── 3. 지원 대상 ──
  if (cardType === 'target') {
    // target에서 - 기준으로 세부 항목 분리
    const targetText = cleanText(target || '');
    const rawItems = targetText.split(/ - /).map(s => s.trim()).filter(s => s.length > 4);
    const targetItems = rawItems.length > 1
      ? rawItems.slice(0, 4).map(s => s.length > 50 ? s.slice(0, 50) + '…' : s)
      : [targetText.slice(0, 70)];
    const content = `
      <div style="background:${t.bg};color:white;padding:10px 28px;border-radius:30px;font-size:22px;font-weight:700;margin-bottom:28px;">
        🎯 지원 대상
      </div>
      <div style="color:${t.title};font-size:40px;font-weight:900;margin-bottom:24px;word-break:keep-all;">
        이런 분들을<br>지원합니다
      </div>
      <div style="width:100%;display:flex;flex-direction:column;gap:12px;">
        ${targetItems.map((item, i) => `
          <div style="display:flex;align-items:flex-start;gap:14px;background:#f8f9ff;border-radius:14px;padding:14px 20px;text-align:left;">
            <div style="width:32px;height:32px;min-width:32px;border-radius:50%;background:${t.bg};color:white;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:900;">${i+1}</div>
            <div style="color:#222;font-size:18px;font-weight:600;line-height:1.5;word-break:keep-all;">${item}</div>
          </div>
        `).join('')}
      </div>`;
    return makeFrame(t.bg, t.clip, content, cardNum, totalCards);
  }

  // ── 4. 지원 내용 ──
  if (cardType === 'support') {
    const supportRaw = support || overview;
    const rawSupport = supportRaw.split(/\n/).map(s => s.replace(/^[-\s]+/, '').trim()).filter(s => s.length > 4);

    // 핵심 요약: 각 항목에서 가장 중요한 구절만 추출
    const summarize = (s) => {
      // 금액·수량 표현이 있으면 그 앞뒤 문맥 우선
      const moneyMatch = s.match(/(.{0,15}[\d,]+[억만천원%개사][\w\s]*)/);
      if (moneyMatch) return moneyMatch[1].trim().slice(0, 38);
      // 괄호 안 내용 제거 후 첫 구절(쉼표·및 앞까지)
      const clean = s.replace(/\([^)]*\)/g, '').trim();
      const firstClause = clean.split(/[,，및]/)[0].trim();
      return firstClause.length > 8 ? firstClause.slice(0, 36) : clean.slice(0, 36);
    };

    const supportItems = rawSupport.length > 1
      ? rawSupport.slice(0, 5).map(summarize)
      : splitLinesByWord(cleanText(supportRaw), 26).slice(0, 4).map(summarize);
    const content = `
      <div style="background:${t.bg};color:white;padding:10px 28px;border-radius:30px;font-size:22px;font-weight:700;margin-bottom:28px;">
        💰 지원 내용
      </div>
      <div style="color:${t.title};font-size:40px;font-weight:900;margin-bottom:20px;word-break:keep-all;">
        지원 내용을<br>확인하세요
      </div>
      <div style="width:100%;display:flex;flex-direction:column;gap:12px;">
        ${supportItems.map(item => `
          <div style="display:flex;align-items:center;gap:12px;background:#f8f9ff;border-radius:12px;padding:14px 20px;text-align:left;">
            <div style="width:8px;height:8px;min-width:8px;border-radius:50%;background:${t.bg};"></div>
            <div style="color:#333;font-size:19px;font-weight:600;line-height:1.4;word-break:keep-all;">${item}</div>
          </div>
        `).join('')}
      </div>`;
    return makeFrame(t.bg, t.clip, content, cardNum, totalCards);
  }

  // ── 5. 신청 방법 ──
  if (cardType === 'apply') {
    const steps = (method || '').split(/[-\n]/).map(s => s.replace(/^접수처.*/, '').trim()).filter(s => s.length > 4 && !s.startsWith('(') && !s.startsWith('※') && !s.startsWith('메일')).slice(0, 2);
    if (steps.length === 0) steps.push('비즈인포 홈페이지에서 온라인 신청');
    const shortContact = contact || '';
    const content = `
      <div style="background:${t.bg};color:white;padding:10px 28px;border-radius:30px;font-size:22px;font-weight:700;margin-bottom:28px;">
        ✅ 신청 방법
      </div>
      <div style="color:${t.title};font-size:44px;font-weight:900;margin-bottom:28px;word-break:keep-all;">
        지금 바로<br>신청하세요!
      </div>
      <div style="width:100%;display:flex;flex-direction:column;gap:12px;margin-bottom:20px;">
        ${steps.map((step, i) => `
          <div style="display:flex;align-items:flex-start;gap:14px;background:#f8f9ff;border-radius:14px;padding:16px 22px;text-align:left;">
            <div style="background:${t.bg};color:white;padding:6px 14px;border-radius:20px;font-size:17px;font-weight:900;flex-shrink:0;white-space:nowrap;">STEP${i+1}</div>
            <div style="color:#222;font-size:19px;font-weight:500;line-height:1.5;word-break:keep-all;">${step.length > 50 ? step.slice(0,50) + '…' : step}</div>
          </div>
        `).join('')}
      </div>
      ${shortContact ? `
      <div style="background:${t.bg};color:white;border-radius:14px;padding:14px 24px;font-size:18px;font-weight:600;width:100%;text-align:center;word-break:keep-all;">
        📞 ${shortContact}
      </div>` : `
      <div style="background:${t.bg};color:white;border-radius:14px;padding:14px 24px;font-size:20px;font-weight:700;width:100%;text-align:center;">
        🔗 bizinfo.go.kr 에서 신청
      </div>`}`;
    return makeFrame(t.bg, t.clip, content, cardNum, totalCards);
  }

  return `<!DOCTYPE html><html><body style="background:${t.bg};width:1080px;height:1080px;display:flex;align-items:center;justify-content:center;"><h1 style="color:white;">${cardType}</h1></body></html>`;
}

// =====================
// HTML → PNG 이미지 변환
// =====================
async function htmlToImage(html, outputPath, browser) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1080, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(1500); // 구글 폰트 로딩 대기
  await page.screenshot({ path: outputPath, type: 'png', clip: { x: 0, y: 0, width: 1080, height: 1080 } });
  await page.close();
}

// =====================
// 카드뉴스 5장 생성
// =====================
async function generateCardImages(item, outputDir, browser) {
  const imgDir = path.join(outputDir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  const overview = item.overview || item.details?.find(d => d.label.includes('사업개요'))?.value || '';
  const method   = item.method  || item.details?.find(d => d.label.includes('사업신청 방법'))?.value || '';
  const contact  = item.contact || item.details?.find(d => d.label.includes('문의처'))?.value || '';
  const period   = item.period  || item.details?.find(d => d.label.includes('신청기간'))?.value || '';
  const org      = item.org     || item.details?.find(d => d.label.includes('소관부처'))?.value || '';
  const agency   = item.agency  || item.details?.find(d => d.label.includes('사업수행기관'))?.value || '';

  const support  = item.support || item.details?.find(d => d.label.includes('지원내용'))?.value || overview;

  const cardData = {
    title: item.title,
    org, agency, period, region: item.region || '전국',
    overview, target: item.target || '', support, method, contact,
    totalCards: 5,
  };

  const cardTypes = ['cover', 'overview', 'target', 'support', 'apply'];

  for (let i = 0; i < cardTypes.length; i++) {
    const cardType = cardTypes[i];
    const imgPath = path.join(imgDir, `card_${i + 1}_${cardType}.png`);
    try {
      const html = makeCardHTML(cardType, { ...cardData, cardNum: i + 1 });
      await htmlToImage(html, imgPath, browser);
      console.log(`    ✅ card_${i + 1}_${cardType}.png`);
    } catch (e) {
      console.log(`    ❌ ${cardType} 실패: ${e.message}`);
    }
  }
}

// =====================
// 템플릿 기반 블로그 글 생성 (인기 블로그 스타일)
// =====================
function generateBlogPost(item, platform) {
  const overview = item.overview || item.details?.find(d => d.label.includes('사업개요'))?.value || '';
  const period   = item.period  || item.details?.find(d => d.label.includes('신청기간'))?.value || '';
  const org      = item.org     || item.details?.find(d => d.label.includes('소관부처'))?.value || '';
  const agency   = item.agency  || item.details?.find(d => d.label.includes('사업수행기관'))?.value || '';
  const method   = item.method  || item.details?.find(d => d.label.includes('사업신청 방법'))?.value || '';
  const contact  = item.contact || item.details?.find(d => d.label.includes('문의처'))?.value || '';
  const target   = item.target || '';
  const title    = item.title;
  const url      = item.url || 'https://www.bizinfo.go.kr';
  const region   = item.region || '전국';

  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const ov  = clean(overview);
  const tg  = clean(target);
  const mt  = clean(method);
  const shortTitle = title.replace(/\[.+?\]\s*/g, '').replace(/\s*수정\s*공고/, '').trim();
  const regionTag  = region !== '전국' ? `${region} ` : '';

  // ── 네이버 블로그 ──
  // 스타일: 인기 정보 블로거 형식 - 짧은 문단, 강조 표현, 현실적인 말투, 해시태그
  if (platform === 'naver') {
    const hashtags = [
      `#정부지원사업`, `#${regionTag}지원사업`, `#소상공인지원`,
      `#창업지원금`, `#중소기업지원`, `#사업공고`,
      `#${shortTitle.replace(/\s+/g,'').slice(0,12)}`,
      `#비즈인포`, `#지원금신청`, `#${org ? org.replace(/\s/g,'').slice(0,8) : '정부사업'}`,
    ].join(' ');

    return `혹시 이 지원사업 알고 계셨나요? 🙋

모르고 지나치기엔 너무 아까운 정보라서 오늘 정리해봤어요.

━━━━━━━━━━━━━━━━━━━━━━━━━━
📌 ${title}
━━━━━━━━━━━━━━━━━━━━━━━━━━


✔️ 어떤 사업인가요?

${ov.slice(0, 180)}${ov.length > 180 ? '...' : ''}

정부에서 직접 지원하는 사업인 만큼, 조건만 맞는다면 꼭 신청해보시길 추천드려요!


✔️ 나도 신청할 수 있을까요?

${tg ? tg.slice(0, 150) : '공고문에서 상세 자격을 확인하세요.'}

위 조건에 해당된다면 놓치지 마세요! ✨


✔️ 꼭 알아야 할 정보 요약

🏢 주관기관 : ${org || '공고문 참조'}
${agency && agency !== org ? `🔧 수행기관 : ${agency}\n` : ''}⏰ 신청기간 : ${period || '공고문 참조'}
📍 지원지역 : ${region}
${contact ? `📞 문 의 처 : ${contact}` : ''}


✔️ 신청은 어떻게 하나요?

${mt ? mt.slice(0, 150) : '비즈인포 홈페이지(bizinfo.go.kr)에서 온라인으로 신청하실 수 있어요.'}

👉 공고 원문 바로가기 : ${url}


⚠️ 신청 기간을 꼭 확인하세요!
마감이 지나면 다음 기회를 기다려야 할 수 있어요.
지금 바로 확인하고 준비해두는 게 좋습니다 😊


${hashtags}`;
  }

  // ── 티스토리 블로그 ──
  // 스타일: 검색 유입 최적화 + 정보전달 블로그 형식 - 소제목 구조, 핵심 강조, 친절한 설명
  if (platform === 'tistory') {
    const targetList = tg
      ? tg.split(/[,，]/).map(s => s.trim()).filter(s => s.length > 1).slice(0, 5)
      : ['공고문에서 상세 자격 확인 필요'];

    return `## ${shortTitle} 신청 방법 총정리 (${new Date().getFullYear()} 최신)

> 💡 **한줄 요약**: ${ov.slice(0, 80)}${ov.length > 80 ? '...' : ''}


### 📍 이 글에서 다루는 내용

- 사업 목적과 주요 내용
- 신청 자격 (나도 해당될까?)
- 지원 내용 상세
- 신청 방법 및 일정
- 문의처 및 공고 원문 링크


---

### 📌 사업 개요

${ov.slice(0, 280)}${ov.length > 280 ? '...' : ''}

${org ? `본 사업은 **${org}**${agency && agency !== org ? `(수행기관: ${agency})` : ''}에서 주관합니다.` : ''}


---

### 🎯 지원 대상 — 나도 신청 가능할까?

아래 조건 중 해당되는 분이라면 신청이 가능합니다.

${targetList.map(t => `- ${t}`).join('\n')}

> ⚠️ 정확한 자격 요건은 반드시 공고 원문에서 확인하세요. 세부 조건이 다를 수 있습니다.


---

### 📋 신청 정보 한눈에 보기

| 항목 | 내용 |
|:---:|:---|
| 주관기관 | ${org || '-'} |
${agency && agency !== org ? `| 수행기관 | ${agency} |\n` : ''}| 신청기간 | **${period || '공고문 참조'}** |
| 지원지역 | ${region} |
| 문의처 | ${contact || '-'} |


---

### 📝 신청 방법

${mt ? mt.slice(0, 200) : '비즈인포 공식 홈페이지(bizinfo.go.kr)를 통해 온라인으로 신청할 수 있습니다.'}

**공고 원문 및 신청서류 확인**: [👉 비즈인포 바로가기](${url})


---

### ✅ 마무리

${regionTag}${shortTitle.slice(0, 20)} 관련 지원사업은 신청 기간이 지나면 다시 기회를 잡기 어렵습니다.
지금 바로 공고 원문을 확인하고, 요건에 맞는다면 서류 준비를 시작해보세요.

궁금한 점은 위 문의처로 직접 연락하시는 것이 가장 정확합니다. 😊`;
  }

  // ── 구글 블로거 ──
  // 스타일: 정제된 정보 전달, HTML 구조, SEO 최적화
  if (platform === 'blogger') {
    const targetList = tg
      ? tg.split(/[,，]/).map(s => s.trim()).filter(s => s.length > 1).slice(0, 5)
      : ['공고문 참조'];

    return `<article>

<h1>${shortTitle} 신청 안내 및 지원 내용 총정리</h1>

<p>
${regionTag}중소기업·소상공인·창업자를 위한 정부 지원사업을 소개합니다.<br>
신청 자격과 방법을 꼼꼼히 확인하고 기회를 놓치지 마세요.
</p>

<hr>

<h2>📌 사업 개요</h2>
<p>${ov.slice(0, 280)}${ov.length > 280 ? '...' : ''}</p>
${org ? `<p><strong>주관:</strong> ${org}${agency && agency !== org ? ` / <strong>수행:</strong> ${agency}` : ''}</p>` : ''}

<hr>

<h2>🎯 지원 대상</h2>
<ul>
${targetList.map(t => `  <li>${t}</li>`).join('\n')}
</ul>
<p><em>※ 세부 자격 요건은 반드시 공고 원문을 확인하시기 바랍니다.</em></p>

<hr>

<h2>📋 주요 정보</h2>
<table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;">
  <tr><th>항목</th><th>내용</th></tr>
  <tr><td>주관기관</td><td>${org || '-'}</td></tr>
  ${agency && agency !== org ? `<tr><td>수행기관</td><td>${agency}</td></tr>` : ''}
  <tr><td>신청기간</td><td><strong>${period || '공고문 참조'}</strong></td></tr>
  <tr><td>지원지역</td><td>${region}</td></tr>
  <tr><td>문의처</td><td>${contact || '-'}</td></tr>
</table>

<hr>

<h2>📝 신청 방법</h2>
<p>${mt ? mt.slice(0, 200) : '비즈인포 홈페이지(bizinfo.go.kr)를 통해 온라인 신청이 가능합니다.'}</p>
<p>
  <a href="${url}" target="_blank" rel="noopener">
    ▶ 공고 원문 확인 및 신청하기
  </a>
</p>

<hr>

<p>
  <small>
    관련 키워드: 정부지원사업, ${regionTag}지원사업, 소상공인지원, 창업지원,
    ${org || ''}, ${shortTitle.slice(0,15)}, bizinfo, 중소기업지원금
  </small>
</p>

</article>`;
  }

  return `제목: ${title}\n\n${ov}`;
}

// =====================
// 메인 실행
// =====================
async function main() {
  console.log('\n========================================');
  console.log('  블로그 콘텐츠 자동 생성기');
  console.log('========================================\n');

  const outputBase = path.join(__dirname, 'output');
  if (!fs.existsSync(outputBase)) {
    console.log('수집된 데이터가 없습니다. 먼저 index.js를 실행하세요.');
    rl.close();
    return;
  }

  const folders = fs.readdirSync(outputBase)
    .filter(f => fs.statSync(path.join(outputBase, f)).isDirectory())
    .sort().reverse();

  if (folders.length === 0) {
    console.log('수집된 데이터가 없습니다.');
    rl.close();
    return;
  }

  console.log('최근 수집 폴더:');
  folders.slice(0, 5).forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  const folderIdx = await ask('\n사용할 폴더 번호 (기본: 1): ');
  const selectedFolder = folders[(parseInt(folderIdx) || 1) - 1];
  const selectedPath = path.join(outputBase, selectedFolder);

  const txtFiles = fs.readdirSync(selectedPath).filter(f => f.endsWith('.txt'));
  console.log(`\n${selectedFolder} 폴더의 파일:`);
  txtFiles.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  const fileIdx = await ask('\n사용할 파일 번호 (기본: 1): ');
  const selectedFile = txtFiles[(parseInt(fileIdx) || 1) - 1];
  const content = fs.readFileSync(path.join(selectedPath, selectedFile), 'utf8');

  const items = [];
  // =====로 split하면 [헤더, 제목조각, 내용조각, 제목조각, 내용조각, ...] 구조
  // 홀수 인덱스 = 제목, 짝수 인덱스(>0) = 내용 → 합쳐서 처리
  const parts = content.split('='.repeat(60));
  for (let i = 1; i < parts.length; i += 2) {
    const titlePart = parts[i] || '';
    const contentPart = parts[i + 1] || '';
    const block = titlePart + contentPart;

    const titleMatch = titlePart.match(/\[제목\] (.+)/);
    const regionMatch = titlePart.match(/\[지역\] (.+)/);
    const urlMatch = contentPart.match(/https?:\/\/[^\s]+/);
    if (!titleMatch) continue;

    // 실제 파일 형식에 맞는 파싱
    const getField = (pattern) => {
      const m = contentPart.match(pattern);
      return m ? m[1].trim() : '';
    };

    const org      = getField(/▪ 소관부처[^:]*:\s*(.+)/);
    const agency   = getField(/▪ 사업수행기관:\s*(.+)/);
    const period   = getField(/▪ 신청기간:\s*(.+)/);
    const contact  = getField(/▪ 문의처:\s*(.+)/);
    const method   = getField(/▪ 신청방법:\s*(.+)/);

    // 사업 개요 추출
    const overviewMatch = contentPart.match(/【사업 개요】\n([\s\S]+?)(?=【|----)/);
    const overviewRaw = overviewMatch ? overviewMatch[1].trim() : '';
    const overview = overviewRaw.replace(/☞/g, '').replace(/\s+/g, ' ').trim();

    // 지원 대상 / 지원 내용 분리
    // 【지원 대상】의 • 첫 번째 항목 = 지원대상, 두 번째 항목 = 지원내용
    const targetSectionMatch = contentPart.match(/【지원 대상】\n([\s\S]+?)(?=【|----)/);
    let target = '';
    let support = '';
    if (targetSectionMatch) {
      const bullets = targetSectionMatch[1].split(/\n\s*•\s*/).map(s => s.replace(/^[•\s]+/, '').trim()).filter(s => s.length > 2);
      // 첫 번째 • = 지원대상, 두 번째 • = 지원내용
      target  = bullets[0] || '';
      // support는 - 기준으로 핵심 항목 추출
      const supportRaw = bullets[1] || '';
      const supportParts = supportRaw.split(/ - /).map(s => s.trim()).filter(s => s.length > 4);
      support = supportParts.length > 1 ? supportParts.join('\n') : supportRaw;
    }
    // 사업 개요의 ☞ 기호 뒤 내용으로 보완
    if (!target || !support) {
      const arrowParts = overviewRaw.split(/☞/).map(s => s.trim()).filter(s => s.length > 2);
      if (!target  && arrowParts[0]) target  = arrowParts[0].replace(/\s+/g, ' ');
      if (!support && arrowParts[1]) support = arrowParts[1].replace(/\s+/g, ' ');
    }

    items.push({
      title: titleMatch[1].trim(),
      region: regionMatch ? regionMatch[1].trim() : '전국',
      url: urlMatch ? urlMatch[0].trim() : '',
      details: [
        { label: '소관부처', value: org },
        { label: '사업수행기관', value: agency },
        { label: '신청기간', value: period },
        { label: '문의처', value: contact },
        { label: '사업신청 방법', value: method },
        { label: '사업개요', value: overview },
      ],
      org, agency, period, contact, method, overview, target, support,
    });
  }

  if (items.length === 0) {
    console.log('파싱된 공고가 없습니다.');
    rl.close();
    return;
  }

  console.log(`\n총 ${items.length}개 공고 로드됨`);
  items.slice(0, 10).forEach((item, i) => console.log(`  ${i + 1}. ${item.title}`));
  if (items.length > 10) console.log(`  ... 외 ${items.length - 10}개`);

  const input = await ask('\n생성할 번호 (전체: all, 예: 1,3,5): ');
  let selected = [];
  if (input.trim().toLowerCase() === 'all') {
    selected = items;
  } else {
    const nums = input.split(',').map(n => parseInt(n.trim()) - 1).filter(n => n >= 0 && n < items.length);
    selected = nums.map(i => items[i]);
  }

  if (selected.length === 0) {
    console.log('선택된 항목이 없습니다.');
    rl.close();
    return;
  }

  const platforms = ['naver', 'tistory', 'blogger'];
  const platformInput = await ask('\n생성할 플랫폼 (전체: all, naver/tistory/blogger 중 선택): ');
  const selectedPlatforms = platformInput.trim().toLowerCase() === 'all'
    ? platforms
    : platformInput.split(',').map(p => p.trim()).filter(p => platforms.includes(p));

  if (selectedPlatforms.length === 0) {
    console.log('올바른 플랫폼을 선택하세요.');
    rl.close();
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const blogDir = path.join(__dirname, 'blog_output', `blog_${timestamp}`);
  fs.mkdirSync(blogDir, { recursive: true });

  console.log(`\n${selected.length}개 공고 처리 시작...\n`);
  console.log('브라우저 시작 중...');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });

  try {
    for (let i = 0; i < selected.length; i++) {
      const item = selected[i];
      console.log(`\n[${i + 1}/${selected.length}] ${item.title}`);

      const itemDir = path.join(blogDir, item.title.replace(/[\/\\:*?"<>|\n\r]/g, '_').slice(0, 50));
      fs.mkdirSync(itemDir, { recursive: true });

      // 1. 카드뉴스 이미지 생성 (고정 템플릿 → Puppeteer 스크린샷)
      console.log('  카드뉴스 이미지 생성 중...');
      try {
        await generateCardImages(item, itemDir, browser);
      } catch (e) {
        console.log(`  이미지 생성 실패: ${e.message}`);
      }

      // 2. 블로그 글 생성 (템플릿 기반)
      for (const platform of selectedPlatforms) {
        console.log(`  ${platform} 블로그 글 생성 중...`);
        try {
          const post = generateBlogPost(item, platform);
          const postFile = path.join(itemDir, `${platform}_post.txt`);
          fs.writeFileSync(postFile, post, 'utf8');
          console.log(`  ✅ ${platform} 완료`);
        } catch (e) {
          console.log(`  ❌ ${platform} 실패: ${e.message}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  console.log(`\n✅ 모든 작업 완료!`);
  console.log(`   저장 위치: ${blogDir}`);

  rl.close();
}

main().catch(err => {
  console.error('오류:', err.message);
  rl.close();
});
