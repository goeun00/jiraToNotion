require("dotenv").config();

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// ── 최신 flash 모델 자동 선택 ──
async function getLatestModel() {
  const key = process.env.GEMINI_API_KEY;
  try {
    const res = await fetch(`${GEMINI_BASE}/models?key=${key}`);
    if (!res.ok) throw new Error();
    const data = await res.json();
    const models = (data.models || [])
      .map((m) => m.name)
      .filter(
        (n) =>
          n.includes("gemini") &&
          n.includes("flash") &&
          !n.includes("lite") &&
          !n.includes("8b") &&
          !n.includes("thinking"),
      )
      .sort()
      .reverse();
    return models[0] || "models/gemini-2.0-flash-latest";
  } catch {
    return "models/gemini-2.0-flash-latest";
  }
}

function geminiUrl(model) {
  return `${GEMINI_BASE}/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
}

// ── 확장자별 리뷰 포인트 ──
function getFileTypeHints(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const hints = {
    css: `
- 셀렉터 specificity 충돌 여부
- 불필요한 중복 선언이나 오버라이드
- 반응형 미디어쿼리 누락
- CSS 변수 일관성
- 애니메이션 성능 (will-change, transform 사용 여부)`,
    scss: `
- 중첩 깊이가 3단계 이하인지
- mixin/variable 재사용 여부
- 불필요한 @extend 사용
- 컴파일 결과 예상 용량`,
    js: `
- null/undefined 안전 처리 여부
- 메모리 누수 가능성 (이벤트 리스너 정리 등)
- 비동기 에러 처리 (try-catch, .catch)
- 전역 변수 오염 여부
- 불필요한 리렌더링 트리거`,
    ts: `
- any 타입 남용 여부
- 타입 가드 필요 여부
- 인터페이스/타입 일관성
- 제네릭 활용 가능 여부
- null/undefined 처리`,
    jsx: `
- 불필요한 리렌더링 (useMemo, useCallback 필요 여부)
- key prop 누락
- 컴포넌트 분리 기준 적절성
- 훅 규칙 준수 (조건문 안 훅 사용 등)
- 접근성 (aria, alt 등)`,
    tsx: `
- 컴포넌트 prop 타입 정의 완전성
- 불필요한 리렌더링 (useMemo, useCallback 필요 여부)
- key prop 누락
- 접근성 (aria, alt 등)`,
    vue: `
- Options API / Composition API 혼용 여부
- v-for에 key 바인딩 여부
- emit 타입 정의 여부
- 불필요한 watch 사용
- 컴포넌트 네이밍 규칙`,
    html: `
- 시맨틱 태그 사용 여부
- 접근성 (alt, role, aria-label)
- SEO 관련 메타 태그
- 불필요한 인라인 스타일`,
    svg: `
- 불필요한 메타데이터나 편집기 잔재 속성 (inkscape, sodipodi 등)
- viewBox 정의 여부
- 하드코딩된 width/height (반응형 방해)
- 최적화 가능한 path 중복
- currentColor 활용 가능 여부`,
  };
  return (
    hints[ext] ||
    `
- 로직 오류 및 버그
- 가독성 및 네이밍
- 성능 이슈
- 보안 취약점`
  );
}

// ── diff 텍스트를 파일별로 파싱 ──
function parseDiffByFile(diffText) {
  const files = [];
  const chunks = diffText.split(/^diff --git /m).filter(Boolean);
  for (const chunk of chunks) {
    const match = chunk.match(/^a\/.+ b\/(.+)\n/);
    if (!match) continue;
    const filename = match[1].trim();
    files.push({ filename, diff: chunk });
  }
  return files;
}

// ── hunk에서 변경 라인 범위 추출 ──
function extractHunkInfo(diff) {
  const hunks = [
    ...diff.matchAll(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/gm),
  ];
  return hunks.length
    ? `변경된 라인 범위 (신규 기준): ${hunks.map((h) => `+${h[2]}`).join(", ")}`
    : "";
}

// ── 파일 하나 리뷰 ──
async function reviewOneFile(filename, diff, model) {
  if (diff.trim().split("\n").length < 4) {
    return { filename, review: "변경 내용 없음 또는 파일 삭제" };
  }

  const hunkInfo = extractHunkInfo(diff);
  const fileHints = getFileTypeHints(filename);

  const prompt = `너는 시니어 프론트엔드 개발자 "도토리"야. 친근하고 따뜻하지만 리뷰는 칼같이 정확하게 해줘 🐿️

파일: "${filename}"
${hunkInfo}

이 파일 타입에서 특히 확인할 것:
${fileHints}

diff:
\`\`\`diff
${diff.slice(0, 6000)}
\`\`\`

아래 형식으로 리뷰해줘. 문제가 없으면 해당 섹션은 생략해도 돼.
반드시 구체적인 라인 번호나 코드 스니펫을 언급해줘.

## 🔴 치명적 문제
(버그, 보안, 데이터 손실 위험 — 반드시 수정)
각 항목: 문제 설명 → 해당 코드 → 수정 방법

## 🟡 개선 권장
(성능, 가독성, 유지보수성)
각 항목: 왜 문제인지 → 어떻게 고치면 되는지

## 🔵 제안 사항
(더 좋아질 수 있는 것들, 선택사항)

## ✅ 잘한 점
(칭찬도 잊지 말기 🌰)

문제가 전혀 없으면: "도토리 도장 찍어줄게요 🐿️✅ 특이사항 없음!"`;

  try {
    const res = await fetch(geminiUrl(model), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.25, maxOutputTokens: 1500 },
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${txt}`);
    }
    const data = await res.json();
    const review =
      data.candidates?.[0]?.content?.parts?.[0]?.text || "리뷰 결과 없음";
    return { filename, review };
  } catch (err) {
    return { filename, review: `리뷰 실패: ${err.message}` };
  }
}

// ── 파일별 코드리뷰 (동시 5개 병렬) ──
async function reviewFilesWithGemini(fileDiffs, model) {
  const CONCURRENCY = 5;
  const results = [];
  let done = 0;

  for (let i = 0; i < fileDiffs.length; i += CONCURRENCY) {
    const batch = fileDiffs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(({ filename, diff }) => reviewOneFile(filename, diff, model)),
    );
    results.push(...batchResults);
    done += batch.length;
    console.log(`리뷰 진행 중: ${done}/${fileDiffs.length} 파일`);
  }

  return results;
}

// ── 전체 diff 요약 ──
async function summarizeDiff(diffText, repo, base, compare, model) {
  const prompt = `너는 시니어 개발자 "도토리"야. 브랜치 비교 결과를 팀장한테 보고하듯이 요약해줘 🐿️

저장소: ${repo}
비교: ${base} ← ${compare}

diff:
\`\`\`diff
${diffText.slice(0, 8000)}
\`\`\`

아래 형식으로 요약해줘:

## 📋 변경 요약
(2-3줄로 핵심만, 어떤 기능/버그/스타일이 바뀌었는지)

## ⚡ 위험도
🟢 낮음 / 🟡 중간 / 🔴 높음 — 그 이유 한 줄

## 📁 주요 변경 파일 (최대 5개)
각 파일마다: 파일명 — 변경 내용 한 줄 요약

## 🐿️ 도토리 한마디
(전체적인 인상을 귀엽고 솔직하게)`;

  try {
    const res = await fetch(geminiUrl(model), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 700 },
      }),
    });
    if (!res.ok) throw new Error(`Gemini API error ${res.status}`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "요약 실패";
  } catch (err) {
    return `요약 실패: ${err.message}`;
  }
}

// ════════════════════════════════════════
// Notion 블록 빌더
// ════════════════════════════════════════

function toChunks(text, maxLen = 1900) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

function paragraphBlock(text) {
  return toChunks(text).map((chunk) => ({
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
}

function calloutBlock(text, emoji, color = "gray_background") {
  const main = text.slice(0, 1900);
  const overflow = text.slice(1900);
  const blocks = [
    {
      object: "block",
      type: "callout",
      callout: {
        rich_text: [{ type: "text", text: { content: main } }],
        icon: { type: "emoji", emoji },
        color,
      },
    },
  ];
  if (overflow) blocks.push(...paragraphBlock(overflow));
  return blocks;
}

function dividerBlock() {
  return { object: "block", type: "divider", divider: {} };
}

function headingBlock(text, level = 2) {
  const type = `heading_${level}`;
  return {
    object: "block",
    type,
    [type]: { rich_text: [{ type: "text", text: { content: text } }] },
  };
}

function toggleBlock(title, children) {
  return {
    object: "block",
    type: "toggle",
    toggle: {
      rich_text: [{ type: "text", text: { content: title } }],
      children,
    },
  };
}

// ── 리뷰 텍스트를 섹션별로 파싱 ──
function parseReviewSections(reviewText) {
  const s = {
    critical: "",
    warning: "",
    suggestion: "",
    good: "",
    clean: false,
  };

  if (reviewText.includes("특이사항 없음")) {
    s.clean = true;
    return s;
  }

  const criticalMatch = reviewText.match(
    /##\s*🔴[^\n]*\n([\s\S]*?)(?=##\s*[🟡🔵✅]|$)/,
  );
  const warningMatch = reviewText.match(
    /##\s*🟡[^\n]*\n([\s\S]*?)(?=##\s*[🔴🔵✅]|$)/,
  );
  const suggMatch = reviewText.match(
    /##\s*🔵[^\n]*\n([\s\S]*?)(?=##\s*[🔴🟡✅]|$)/,
  );
  const goodMatch = reviewText.match(
    /##\s*✅[^\n]*\n([\s\S]*?)(?=##\s*[🔴🟡🔵]|$)/,
  );

  if (criticalMatch) s.critical = criticalMatch[1].trim();
  if (warningMatch) s.warning = warningMatch[1].trim();
  if (suggMatch) s.suggestion = suggMatch[1].trim();
  if (goodMatch) s.good = goodMatch[1].trim();

  return s;
}

// ── 파일 리뷰 → Notion 블록 ──
function buildFileReviewBlocks(filename, reviewText) {
  const blocks = [];
  const s = parseReviewSections(reviewText);

  blocks.push(headingBlock(`📄 ${filename}`, 3));

  // 문제없는 파일
  if (s.clean) {
    blocks.push(
      ...calloutBlock(
        "🐿️✅ 특이사항 없음! 도토리 도장 찍어줄게요 🌰",
        "✅",
        "green_background",
      ),
    );
    return blocks;
  }

  // 섹션 파싱 실패 시 raw fallback
  const hasSections = s.critical || s.warning || s.suggestion || s.good;
  if (!hasSections) {
    blocks.push(...paragraphBlock(reviewText));
    return blocks;
  }

  // 🔴 치명적 — callout 빨간 배경
  if (s.critical) {
    blocks.push(
      ...calloutBlock(
        `🔴 치명적 문제 — 반드시 수정!\n\n${s.critical}`,
        "🚨",
        "red_background",
      ),
    );
  }

  // 🟡 개선 권장 — callout 노란 배경
  if (s.warning) {
    blocks.push(
      ...calloutBlock(
        `🟡 개선 권장\n\n${s.warning}`,
        "⚠️",
        "yellow_background",
      ),
    );
  }

  // 🔵 제안 — toggle (접어두기)
  if (s.suggestion) {
    blocks.push(
      toggleBlock(`🔵 제안 사항 (선택)`, paragraphBlock(s.suggestion)),
    );
  }

  // ✅ 잘한 점 — callout 초록 배경
  if (s.good) {
    blocks.push(
      ...calloutBlock(`✅ 잘한 점\n\n${s.good}`, "🌰", "green_background"),
    );
  }

  return blocks;
}

// ── 요약 → Notion 블록 ──
function buildSummaryBlocks(summaryText, repo, base, compare) {
  return [
    ...calloutBlock(
      `🐿️ 도토리 코드리뷰\n${repo}   ${compare} → ${base}\n${new Date().toLocaleString("ko-KR")}`,
      "🐿️",
      "orange_background",
    ),
    headingBlock("📋 전체 요약", 2),
    ...paragraphBlock(summaryText),
    dividerBlock(),
  ];
}

// ── 메인 진입점 ──
async function runCodeReview(diffText, repo, base, compare) {
  const model = await getLatestModel();
  console.log(`using Gemini model: ${model}`);

  const [summary, fileReviews] = await Promise.all([
    summarizeDiff(diffText, repo, base, compare, model),
    reviewFilesWithGemini(parseDiffByFile(diffText), model),
  ]);

  return { summary, fileReviews };
}

// ── Notion 페이지용 블록 생성 (notion.js에서 호출) ──
function buildNotionBlocks(summary, fileReviews, repo, base, compare) {
  return {
    summaryBlocks: buildSummaryBlocks(summary, repo, base, compare),
    fileBlocks: fileReviews.flatMap(({ filename, review }) =>
      buildFileReviewBlocks(filename, review),
    ),
  };
}

module.exports = { runCodeReview, buildNotionBlocks };
