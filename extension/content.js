// 확장 프로그램 영역: hook.js 가 잡은 문제를 background 로 보내고, 답이 오면 보기 버튼을 클릭
const CLICK_WAIT_MS = 60000;
const clicked = new Set();
const isTop = window === window.top;

window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.__quiznSolver !== "quiz") return;
  const { quiz } = e.data;
  if (quiz.quizType && quiz.quizType !== "SEL") {
    console.log("[QuizN Solver] 4지선다가 아니라 건너뜀:", quiz.quizType);
    return;
  }
  chrome.runtime.sendMessage({ type: "solve", quiz });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "solving") {
    if (isTop) showStatus(`Q${msg.quiz.quizNum ?? ""} ${msg.quiz.question}`, "풀이 중…");
  } else if (msg.type === "answer") {
    const { quiz, result } = msg;
    if (!result.ok) {
      if (isTop) showStatus(`Q${quiz.quizNum ?? ""} ${quiz.question}`, `실패: ${result.error}`, true);
      return;
    }
    const n = result.answer;
    if (isTop) {
      showStatus(
        `Q${quiz.quizNum ?? ""} ${quiz.question}`,
        `정답 ${n}. ${quiz.options[n - 1]}  (${(result.ms / 1000).toFixed(1)}초, ${result.model})`
      );
    }
    clickWhenReady(quiz, n);
  }
});

// 현재 프레임에 해당 문제의 보기 버튼이 나타나면 클릭
function clickWhenReady(quiz, n) {
  if (clicked.has(quiz.quizSeq)) return;
  const deadline = Date.now() + CLICK_WAIT_MS;

  const tryClick = () => {
    if (clicked.has(quiz.quizSeq)) return true;
    const seqInput = document.querySelector('#quzPlayAnsrForm input[name="quizSeq"]');
    const btn = document.getElementById(`optn${n}`);
    if (!seqInput || !btn || seqInput.value !== String(quiz.quizSeq)) return false;
    clicked.add(quiz.quizSeq);
    btn.click();
    console.log(`[QuizN Solver] Q${quiz.quizNum} → ${n}번 클릭`);
    return true;
  };

  if (tryClick()) return;
  const timer = setInterval(() => {
    if (tryClick() || Date.now() > deadline) clearInterval(timer);
  }, 50);
}

// 화면 우측 하단 상태 표시
let box;
function showStatus(title, body, isError = false) {
  if (!document.body) return;
  if (!box) {
    box = document.createElement("div");
    box.style.cssText =
      "position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:360px;padding:10px 12px;" +
      "border-radius:8px;background:rgba(20,20,20,.88);color:#fff;font:13px/1.4 -apple-system,sans-serif;" +
      "box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none;white-space:pre-wrap;";
    document.body.appendChild(box);
  }
  box.style.borderLeft = `4px solid ${isError ? "#ef4444" : "#22c55e"}`;
  box.textContent = `${title}\n→ ${body}`;
}

// 최상위 페이지에서만: 연결 예열 + 20초마다 유지
if (isTop) {
  const ping = () => chrome.runtime.sendMessage({ type: "warm" }).catch(() => {});
  ping();
  setInterval(ping, 20000);
}
