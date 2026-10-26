// 페이지(MAIN world)에서 실행: clientQuizDetail.do 요청 본문에서 문제/보기를 가로채 content.js 로 전달
(() => {
  const TARGET = "clientQuizDetail.do";

  function toParams(body) {
    if (!body) return null;
    if (typeof body === "string") return new URLSearchParams(body);
    if (body instanceof URLSearchParams) return body;
    if (body instanceof FormData) return new URLSearchParams([...body].filter(([, v]) => typeof v === "string"));
    return null;
  }

  function emit(body) {
    const p = toParams(body);
    if (!p || !p.get("question")) return;
    const quiz = {
      quizSeq: p.get("quizSeq"),
      quizNum: p.get("quizNum"),
      quizType: p.get("quizType"),
      question: p.get("question"),
      options: [1, 2, 3, 4].map((i) => p.get(`selOptn${i}Text`) || ""),
    };
    window.postMessage({ __quiznSolver: "quiz", quiz }, "*");
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__quiznUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (this.__quiznUrl && this.__quiznUrl.includes(TARGET)) {
      try { emit(body); } catch (e) { console.warn("[QuizN Solver]", e); }
    }
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input && input.url;
      if (url && url.includes(TARGET)) emit(init && init.body);
    } catch (e) { console.warn("[QuizN Solver]", e); }
    return origFetch.apply(this, arguments);
  };
})();
