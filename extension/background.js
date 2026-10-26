import { GEMINI_API_KEY, TYPESAFE_API_KEY } from "./config.js";

// 빠른 순서대로 시도. 실패하면 다음 모델로 넘어감.
const MODELS = [
  { name: "gemini-3.5-flash-lite", thinkingConfig: { thinkingLevel: "minimal" } },
  { name: "gemini-2.5-flash-lite", thinkingConfig: { thinkingBudget: 0 } },
];
const TIMEOUT_MS = 8000;
// 같은 요청을 동시에 여러 개 보내 가장 먼저 온 답을 사용 (응답 시간 편차 줄이기)
const HEDGE = 2;
const API = "https://generativelanguage.googleapis.com/v1beta/models";

// 결정 모델 Jev: Gemini 와 동시에 출발, 고른 보기 확률이 이 값 이상이면 Gemini 를 기다리지 않고 바로 채택
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const JEV_MODEL = "jev-latest";
const JEV_MIN_PROB = 0.7;
const JEV_TIMEOUT_MS = 3000;

function buildPrompt(quiz) {
  return (
    "다음 4지선다 퀴즈의 정답 번호 하나만 답하라. 문제에 '아닌 것', '틀린 것' 같은 부정 표현이 있는지 주의하라.\n" +
    `문제: ${quiz.question}\n` +
    quiz.options.map((o, i) => `${i + 1}. ${o}`).join("\n")
  );
}

async function ask(model, quiz, signal) {
  const res = await fetch(`${API}/${model.name}:generateContent`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(quiz) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: "text/x.enum",
        responseSchema: { type: "STRING", enum: ["1", "2", "3", "4"] },
        thinkingConfig: model.thinkingConfig,
      },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `HTTP ${res.status}`);
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  const n = text.match(/[1-4]/)?.[0];
  if (!n) throw new Error(`unexpected answer: ${text}`);
  return n;
}

// 같은 모델에 HEDGE 개를 동시에 보내고 가장 빠른 답을 채택, 나머지는 취소
async function askHedged(model, quiz) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await Promise.any(Array.from({ length: HEDGE }, () => ask(model, quiz, ctrl.signal)));
  } catch (e) {
    throw e instanceof AggregateError ? e.errors[0] : e;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

async function askJev(quiz) {
  // 보기 글자를 그대로 선택지 이름으로 사용 (중복·빈 보기면 opt1~4 이름 + 설명으로 대체)
  const unique = new Set(quiz.options).size === 4 && quiz.options.every((o) => o.trim());
  const keys = quiz.options.map((o, i) => (unique ? o : `opt${i + 1}`));
  const criteria = Object.fromEntries(keys.map((k, i) => [k, unique ? null : quiz.options[i]]));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), JEV_TIMEOUT_MS);
  try {
    const res = await fetch(JEV_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TYPESAFE_API_KEY}` },
      body: JSON.stringify({
        model: JEV_MODEL,
        state: { quiz_question: quiz.question },
        questions: {
          answer: { type: "choice", instructions: "Which option is the correct answer to `quiz_question`?", criteria },
        },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error?.message || `HTTP ${res.status}`);
    const a = data.answers?.answer;
    const idx = keys.indexOf(a?.choice);
    if (idx < 0) throw new Error(`unexpected choice: ${a?.choice}`);
    return { answer: String(idx + 1), prob: a.probabilities?.[a.choice] ?? 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function askGemini(quiz) {
  let lastErr;
  for (const model of MODELS) {
    try {
      return { answer: await askHedged(model, quiz), model: model.name };
    } catch (e) {
      lastErr = e;
      console.warn(`[QuizN Solver] ${model.name} 실패:`, e);
    }
  }
  throw lastErr;
}

async function solve(quiz) {
  const started = Date.now();
  const done = (r) => ({ ok: true, ...r, ms: Date.now() - started });
  const gemini = askGemini(quiz);
  gemini.catch(() => {});

  let jev;
  try {
    jev = await askJev(quiz);
    if (jev.prob >= JEV_MIN_PROB) {
      return done({ answer: jev.answer, model: `${JEV_MODEL} p=${jev.prob.toFixed(2)}` });
    }
  } catch (e) {
    console.warn("[QuizN Solver] Jev 실패:", e);
  }

  try {
    return done(await gemini);
  } catch (e) {
    // Gemini 도 실패하면 확률이 낮더라도 Jev 답 사용
    if (jev) return done({ answer: jev.answer, model: `${JEV_MODEL} p=${jev.prob.toFixed(2)} (Gemini 실패)` });
    return { ok: false, error: String(e), ms: Date.now() - started };
  }
}

// 퀴즈 페이지가 열려 있는 동안 구글 API 연결을 미리 열어두고 유지 (첫 문제의 접속 지연 ~0.8초 제거)
function warm() {
  fetch(`${API}/${MODELS[0].name}`, { headers: { "x-goog-api-key": GEMINI_API_KEY } }).catch(() => {});
  fetch("https://api.typesafe.ai/v1/models", { headers: { Authorization: `Bearer ${TYPESAFE_API_KEY}` } }).catch(() => {});
}

// 같은 문제는 한 번만 풀고, 결과는 탭의 모든 프레임에 뿌림
// (요청을 보낸 프레임과 보기 버튼이 그려지는 프레임이 다를 수 있음)
const seen = new Set();

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "warm") return warm();
  if (msg?.type !== "solve") return;
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const key = `${tabId}:${msg.quiz.quizSeq}`;
  if (seen.has(key)) return;
  seen.add(key);
  setTimeout(() => seen.delete(key), 120000);

  chrome.tabs.sendMessage(tabId, { type: "solving", quiz: msg.quiz }).catch(() => {});
  solve(msg.quiz).then((result) =>
    chrome.tabs.sendMessage(tabId, { type: "answer", quiz: msg.quiz, result }).catch(() => {})
  );
});
