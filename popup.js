const resultDiv = document.getElementById("result");

let pendingAnswers = null;

const PROVIDERS = {
    gemini:     { placeholder: 'AIza...',     storageKey: 'geminiKey',     link: 'https://ai.google.dev/aistudio',        linkText: 'Get Free Key →', models: ['gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-flash'] },
    groq:       { placeholder: 'gsk_...',     storageKey: 'groqKey',       link: 'https://console.groq.com/keys',         linkText: 'Get Free Key →', models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'] },
    openai:     { placeholder: 'sk-...',      storageKey: 'openaiKey',     link: 'https://platform.openai.com/api-keys',  linkText: 'Get API Key →',  models: ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'] },
    claude:     { placeholder: 'sk-ant-...', storageKey: 'claudeKey',     link: 'https://console.anthropic.com/',        linkText: 'Get API Key →',  models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7'] },
    openrouter: { placeholder: 'sk-or-...',  storageKey: 'openrouterKey', link: 'https://openrouter.ai/keys',            linkText: 'Get Free Key →', models: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemma-3-27b-it:free', 'mistralai/mistral-7b-instruct:free'] }
};

let currentProvider = 'gemini';

function switchProvider(provider) {
    currentProvider = provider;
    const cfg = PROVIDERS[provider];

    document.querySelectorAll('.provider-pill').forEach(p => p.classList.toggle('active', p.dataset.provider === provider));
    document.getElementById('apiKeyInput').placeholder = cfg.placeholder;

    const link = document.getElementById('getKeyLink');
    link.href = cfg.link;
    link.textContent = cfg.linkText;

    const modelSelect = document.getElementById('modelSelect');
    modelSelect.innerHTML = '';
    cfg.models.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSelect.appendChild(opt);
    });
    chrome.storage.local.get(['aiModel_' + provider], r => {
        if (r['aiModel_' + provider]) modelSelect.value = r['aiModel_' + provider];
    });

    const keysToLoad = provider === 'gemini' ? [cfg.storageKey, 'userApiKey'] : [cfg.storageKey];
    chrome.storage.local.get(keysToLoad, r => {
        document.getElementById('apiKeyInput').value = r[cfg.storageKey] || (provider === 'gemini' ? r.userApiKey || '' : '');
        document.getElementById('apiKeyInput').type = 'password';
        document.getElementById('toggleVisibilityBtn').textContent = '👁️';
    });

    chrome.storage.local.set({ aiProvider: provider });
}

document.querySelectorAll('.provider-pill').forEach(pill => {
    pill.addEventListener('click', () => switchProvider(pill.dataset.provider));
});

document.getElementById('modelSelect').addEventListener('change', () => {
    chrome.storage.local.set({ ['aiModel_' + currentProvider]: document.getElementById('modelSelect').value });
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    resultDiv.style.display = 'none';
  });
});

function setLoading(btn, isLoading, loadingText, defaultText) {
  btn.disabled = isLoading;
  btn.innerHTML = isLoading ? `<span class="spinner"></span> ${loadingText}` : defaultText;
  btn.style.opacity = isLoading ? "0.7" : "1";
  btn.style.cursor = isLoading ? "not-allowed" : "pointer";
}

function showResult(text, type = "default") {
  resultDiv.style.display = "block";
  resultDiv.innerText = text;
  if (type === "error") {
    resultDiv.style.color = "#ef4444";
    resultDiv.style.borderColor = "#f87171";
    resultDiv.style.backgroundColor = "#fef2f2";
  } else if (type === "success") {
    resultDiv.style.color = "#16a34a";
    resultDiv.style.borderColor = "#4ade80";
    resultDiv.style.backgroundColor = "#f0fdf4";
  } else {
    resultDiv.style.color = "var(--foreground)";
    resultDiv.style.borderColor = "var(--border)";
    resultDiv.style.backgroundColor = "var(--background)";
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatQuestionsAsText(questions) {
  return questions.map((q) => {
    let out = `Q${q.questionNumber}. ${escapeHtml(q.question)}`;
    if (q.options && q.options.length > 0) {
      out += "\n" + q.options.map((opt, j) => `  ${String.fromCharCode(97 + j)}) ${escapeHtml(opt)}`).join("\n");
    }
    if (q.type && q.type !== "unknown") out += `\n  [${escapeHtml(q.type)}]`;
    return out;
  }).join("\n\n");
}

function formatPreview(questions, answers) {
  const lines = [];
  answers.forEach((ans) => {
    const q = questions.find(x => x.questionNumber === ans.questionNumber);
    const questionText = q ? q.question : `Question ${ans.questionNumber}`;
    lines.push(`Q${ans.questionNumber}. ${questionText}`);
    if (ans.correctOptions && ans.correctOptions.length > 0) {
      lines.push(`→ ${ans.correctOptions.join(', ')}`);
    }
    if (ans.explanation) {
      lines.push(`  ${ans.explanation}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

chrome.storage.local.get(['aiProvider'], r => {
    switchProvider(r.aiProvider || 'gemini');
});

const toggleIds = ["toggleAutoSubmit", "toggleExplanations", "togglePreview", "togglePerWeek", "toggleADHDNotes", "toggleHumanStyle"];
chrome.storage.local.get([...toggleIds, "walkAwayActive"], (result) => {
  toggleIds.forEach(id => {
    const el = document.getElementById(id);
    if (el && result[id] !== undefined) el.checked = !!result[id];
  });

  const weekArea = document.getElementById("weekSelectorArea");
  if (document.getElementById("togglePerWeek").checked) {
    weekArea.style.display = "flex";
  }

  if (result.walkAwayActive) {
    const btns = document.getElementById("walkAwayBtns");
    if (btns) btns.style.display = "flex";
    const startBtn = document.getElementById("startWalkAwayBtn");
    if (startBtn) { startBtn.disabled = true; startBtn.textContent = "Running..."; }
    const status = document.getElementById("walkAwayStatus");
    if (status) status.textContent = "Walk-Away mode is active. Course completing in background.";
  }
});

toggleIds.forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("change", () => {
      chrome.storage.local.set({ [id]: el.checked });

      if (id === "togglePerWeek") {
        const weekArea = document.getElementById("weekSelectorArea");
        weekArea.style.display = el.checked ? "flex" : "none";
      }
    });
  }
});


(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const isCoursera = tab && tab.url && /coursera\.org\/learn\//.test(tab.url);
  const isSkillsNetwork = tab && tab.url && /skills\.network/.test(tab.url);
  const isValidPage = isCoursera || isSkillsNetwork;

  if (!isValidPage) {
    ["explainBtn", "completeVideosBtn", "showQuestionsBtn", "completeEverythingBtn"].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) {
        btn.disabled = true;
        btn.style.opacity = "0.4";
        btn.title = "Navigate to a Coursera or Skills Network page first";
      }
    });
    showResult("Open a Coursera course or Skills Network assignment page to use these features.", "error");

    document.getElementById("tokenDot").className = "status-dot not-ready";
    document.getElementById("tokenStatus").textContent = "Not on a supported page";
    return;
  }

  if (isSkillsNetwork) {
    ["completeVideosBtn", "completeEverythingBtn", "autopilotBtn", "specCompleteBtn", "speedRunBtn"].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { btn.disabled = true; btn.style.opacity = "0.4"; }
    });
    document.getElementById("tokenDot").className = "status-dot ready";
    document.getElementById("tokenStatus").textContent = "Skills Network — use Solve Quiz";
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: "getTokenStatus" }, (response) => {
    const dot = document.getElementById("tokenDot");
    const statusText = document.getElementById("tokenStatus");

    if (chrome.runtime.lastError || !response) {
      dot.className = "status-dot not-ready";
      statusText.textContent = "Refresh page to activate";
      return;
    }

    if (response.hasToken && response.hasCourseId) {
      dot.className = "status-dot ready";
      statusText.textContent = "Ready";
    } else if (response.hasCourseId) {
      dot.className = "status-dot partial";
      statusText.textContent = "Browse the course to activate token";
    } else {
      dot.className = "status-dot not-ready";
      statusText.textContent = "Navigate to a course page";
    }
  });
})();

document.getElementById("saveBtn").addEventListener("click", () => {
  const key = document.getElementById("apiKeyInput").value.trim();
  const status = document.getElementById("status");
  if (!key) {
    status.style.color = "#ef4444";
    status.innerText = "Enter a key first.";
    setTimeout(() => { status.innerText = ""; status.style.color = "#10b981"; }, 2000);
    return;
  }
  const saveObj = { [PROVIDERS[currentProvider].storageKey]: key, aiProvider: currentProvider };
  if (currentProvider === 'gemini') saveObj.userApiKey = key;
  chrome.storage.local.set(saveObj, () => {
    status.innerText = "Key saved!";
    setTimeout(() => (status.innerText = ""), 2000);
  });
});

document.getElementById("clearKeyBtn").addEventListener("click", () => {
  document.getElementById("apiKeyInput").value = "";
  const keysToRemove = [PROVIDERS[currentProvider].storageKey];
  if (currentProvider === 'gemini') keysToRemove.push('userApiKey');
  chrome.storage.local.remove(keysToRemove);
  const status = document.getElementById("status");
  status.style.color = "#ef4444";
  status.innerText = "Key cleared.";
  setTimeout(() => { status.innerText = ""; status.style.color = "#10b981"; }, 2000);
});

document.getElementById("toggleVisibilityBtn").addEventListener("click", () => {
  const input = document.getElementById("apiKeyInput");
  const btn = document.getElementById("toggleVisibilityBtn");
  if (input.type === "password") {
    input.type = "text";
    btn.textContent = "🙈";
  } else {
    input.type = "password";
    btn.textContent = "👁️";
  }
});

document.getElementById("explainBtn").addEventListener("click", async () => {
  const btn = document.getElementById("explainBtn");
  const previewToggle = document.getElementById("togglePreview");
  const explanationsToggle = document.getElementById("toggleExplanations");
  const humanStyleToggle = document.getElementById("toggleHumanStyle");
  const customInstructions = document.getElementById("customInstructions").value.trim();

  setLoading(btn, true, "Solving...", "Solve Current Quiz");
  resultDiv.style.display = "none";
  document.getElementById("previewArea").style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (previewToggle.checked) {
      chrome.tabs.sendMessage(tab.id, { action: "getSelection" }, (selResponse) => {
        if (chrome.runtime.lastError || !selResponse || !selResponse.data || selResponse.data.length === 0) {
          showResult("No questions found on this page.", "error");
          setLoading(btn, false, "", "Solve Current Quiz");
          return;
        }

        const questions = selResponse.data;

        chrome.runtime.sendMessage(
          {
            action: "fetchAIExplanation",
            text: questions,
            withExplanations: explanationsToggle.checked,
            humanStyle: humanStyleToggle.checked,
            customInstructions
          },
          (aiResponse) => {
            setLoading(btn, false, "", "Solve Current Quiz");

            if (aiResponse && aiResponse.error) {
              showResult("Error: " + aiResponse.error, "error");
              return;
            }
            if (aiResponse && aiResponse.result) {
              pendingAnswers = { tabId: tab.id, data: aiResponse.result };
              const previewArea = document.getElementById("previewArea");
              const previewContent = document.getElementById("previewContent");
              previewContent.textContent = formatPreview(questions, aiResponse.result);
              previewArea.style.display = "flex";
            } else {
              showResult("An unknown error occurred.", "error");
            }
          }
        );
      });
    } else {
      chrome.tabs.sendMessage(
        tab.id,
        {
          action: "solveQuizDirectly",
          withExplanations: explanationsToggle.checked,
          humanStyle: humanStyleToggle.checked,
          customInstructions
        },
        () => {
          if (chrome.runtime.lastError) {
            showResult("Please refresh the page to use the extension.", "error");
          } else {
            showResult("AI Solver triggered! You can close this popup while it works.", "success");
          }
          setLoading(btn, false, "", "Solve Current Quiz");
        }
      );
    }
  } catch {
    showResult("An unexpected error occurred.", "error");
    setLoading(btn, false, "", "Solve Current Quiz");
  }
});

document.getElementById("applyAnswersBtn").addEventListener("click", async () => {
  if (!pendingAnswers) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetTabId = pendingAnswers.tabId || tab.id;

  chrome.tabs.sendMessage(
    targetTabId,
    { action: "applyStoredAnswers", data: pendingAnswers.data },
    (response) => {
      document.getElementById("previewArea").style.display = "none";
      pendingAnswers = null;
      if (response && response.status === "already_correct") {
        showResult("Already answered correctly — nothing changed.", "success");
      } else {
        showResult("Answers applied successfully!", "success");
      }
    }
  );
});

document.getElementById("discardPreviewBtn").addEventListener("click", () => {
  document.getElementById("previewArea").style.display = "none";
  pendingAnswers = null;
});

document.getElementById("showQuestionsBtn").addEventListener("click", async () => {
  const btn = document.getElementById("showQuestionsBtn");
  setLoading(btn, true, "Extracting...", "Copy Questions Only");
  resultDiv.style.display = "none";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { action: "getSelection" }, (response) => {
    setLoading(btn, false, "", "Copy Questions Only");

    if (chrome.runtime.lastError) {
      showResult("Please refresh the page to use the extension.", "error");
      return;
    }
    if (!response || !response.data || response.data.length === 0) {
      showResult("No questions found on this page.", "error");
      return;
    }

    const formatted = formatQuestionsAsText(response.data);
    const plainForCopy = response.data.map((q) => {
      let out = `Q${q.questionNumber}. ${q.question}`;
      if (q.options && q.options.length > 0) {
        out += "\n" + q.options.map((opt, j) => `  ${String.fromCharCode(97 + j)}) ${opt}`).join("\n");
      }
      if (q.type && q.type !== "unknown") out += `\n  [${q.type}]`;
      return out;
    }).join("\n\n");

    const count = response.data.length;

    resultDiv.style.display = "block";
    resultDiv.style.color = "var(--foreground)";
    resultDiv.style.borderColor = "var(--border)";
    resultDiv.style.backgroundColor = "var(--background)";
    resultDiv.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:8px;">
        <strong style="font-size:12px;color:var(--foreground);">${escapeHtml(String(count))} question${count !== 1 ? "s" : ""} found:</strong>
        <button id="copyContentBtn" class="btn btn-primary" style="height:24px;padding:0 10px;width:auto;font-size:11px;margin:0;">Copy</button>
      </div>
      <div style="white-space:pre-wrap;font-size:12px;color:var(--muted-foreground);user-select:all;">${formatted}</div>
    `;

    document.getElementById("copyContentBtn").addEventListener("click", (e) => {
      navigator.clipboard.writeText(plainForCopy).then(() => {
        e.target.innerText = "Copied!";
        e.target.style.backgroundColor = "#16a34a";
        setTimeout(() => {
          e.target.innerText = "Copy";
          e.target.style.backgroundColor = "var(--primary)";
        }, 2000);
      });
    });
  });
});

document.getElementById("completeEverythingBtn").addEventListener("click", async () => {
  const btn = document.getElementById("completeEverythingBtn");
  setLoading(btn, true, "Starting...", 'Complete Everything (AI) <span class="badge" style="background:rgba(255,255,255,0.25);color:#fff;">videos + quizzes</span>');
  resultDiv.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: "startFullCourse" }, (response) => {
      if (chrome.runtime.lastError) {
        showResult("Please refresh the Coursera page and try again.", "error");
      } else if (response && response.status === "started") {
        showResult("Full course completion started! Videos, readings, and all quizzes will be completed automatically. Watch the banner on the page.", "success");
      } else if (response && response.error) {
        showResult(response.error, "error");
      }
      setLoading(btn, false, "", 'Complete Everything (AI) <span class="badge" style="background:rgba(255,255,255,0.25);color:#fff;">videos + quizzes</span>');
    });
  } catch {
    setLoading(btn, false, "", 'Complete Everything (AI) <span class="badge" style="background:rgba(255,255,255,0.25);color:#fff;">videos + quizzes</span>');
  }
});

document.getElementById("completeVideosBtn").addEventListener("click", async () => {
  const btn = document.getElementById("completeVideosBtn");
  setLoading(btn, true, "Working...", "Complete Materials");
  resultDiv.style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    chrome.tabs.sendMessage(tab.id, { action: "completeVideos" }, (response) => {
      if (chrome.runtime.lastError) {
        showResult("Please wait a moment or refresh the Coursera page to use this feature.", "error");
      } else if (response && response.status === "started") {
        showResult("Automagically completing course! Watch the banner on the page.", "success");
      } else if (response && response.error) {
        showResult(response.error, "error");
      }
      setLoading(btn, false, "", "Complete Materials");
    });
  } catch {
    setLoading(btn, false, "", "Complete Materials");
  }
});

document.getElementById("loadWeeksBtn").addEventListener("click", async () => {
  const btn = document.getElementById("loadWeeksBtn");
  setLoading(btn, true, "Loading...", "Load Course Weeks");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { action: "loadCourseWeeks" }, (response) => {
    setLoading(btn, false, "", "Load Course Weeks");

    if (chrome.runtime.lastError || !response) {
      showResult("Could not load weeks. Refresh the page first.", "error");
      return;
    }

    if (response.error) {
      showResult(response.error, "error");
      return;
    }

    if (!response.modules || response.modules.length === 0) {
      showResult("No weeks/modules found for this course.", "error");
      return;
    }

    const weekList = document.getElementById("weekList");
    weekList.innerHTML = "";
    response.modules.forEach((mod) => {
      const label = document.createElement("label");
      label.className = "week-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = mod.id;
      cb.checked = true;
      const text = document.createTextNode(mod.name);
      label.appendChild(cb);
      label.appendChild(text);
      weekList.appendChild(label);
    });

    weekList.style.display = "flex";
    document.getElementById("completeSelectedBtn").style.display = "block";
  });
});

document.getElementById("completeSelectedBtn").addEventListener("click", async () => {
  const btn = document.getElementById("completeSelectedBtn");
  const weekList = document.getElementById("weekList");
  const checkboxes = weekList.querySelectorAll('input[type="checkbox"]:checked');
  const moduleIds = Array.from(checkboxes).map(cb => cb.value);

  if (moduleIds.length === 0) {
    showResult("Select at least one week to complete.", "error");
    return;
  }

  setLoading(btn, true, "Working...", "Complete Selected Weeks");
  resultDiv.style.display = "none";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { action: "completeVideos", moduleIds }, (response) => {
    if (chrome.runtime.lastError) {
      showResult("Please refresh the Coursera page and try again.", "error");
    } else if (response && response.status === "started") {
      showResult("Completing selected weeks! Watch the banner on the page.", "success");
    } else if (response && response.error) {
      showResult(response.error, "error");
    }
    setLoading(btn, false, "", "Complete Selected Weeks");
  });
});

chrome.storage.local.get(["customInstructions"], (result) => {
  if (result.customInstructions) {
    document.getElementById("customInstructions").value = result.customInstructions;
  }
});

document.getElementById("saveInstructionsBtn").addEventListener("click", () => {
  const val = document.getElementById("customInstructions").value.trim();
  chrome.storage.local.set({ customInstructions: val }, () => {
    const btn = document.getElementById("saveInstructionsBtn");
    const orig = btn.innerText;
    btn.innerText = "Saved!";
    setTimeout(() => { btn.innerText = orig; }, 1500);
  });
});

document.getElementById("customInstrTrigger").addEventListener("click", () => {
  document.getElementById("customInstrBody").classList.toggle("open");
  document.getElementById("customInstrChevron").classList.toggle("open");
});

document.getElementById("walkAwayTrigger").addEventListener("click", () => {
  document.getElementById("walkAwayBody").classList.toggle("open");
  document.getElementById("walkAwayChevron").classList.toggle("open");
});

document.getElementById("clearCacheBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "clearCache" }, () => {
    showResult("Answer cache cleared.", "success");
  });
});

document.getElementById("flashcardsBtn").addEventListener("click", async () => {
  const btn = document.getElementById("flashcardsBtn");
  setLoading(btn, true, "Generating...", "Generate Flashcards");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "generateFlashcards" }, () => {
    setLoading(btn, false, "", "Generate Flashcards");
    if (chrome.runtime.lastError) {
      showResult("Please refresh the Coursera page first.", "error");
    } else {
      showResult("Flashcards generating — watch the page banner!", "success");
    }
  });
});

document.getElementById("peerReviewBtn").addEventListener("click", async () => {
  const btn = document.getElementById("peerReviewBtn");
  setLoading(btn, true, "Filling...", "Fill Peer Review");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "fillPeerReview" }, (response) => {
    setLoading(btn, false, "", "Fill Peer Review");
    if (chrome.runtime.lastError || !response) {
      showResult("Please refresh the Coursera page first.", "error");
    } else if (response.error) {
      showResult(response.error, "error");
    } else {
      showResult("Peer review filled! Check the page.", "success");
    }
  });
});

document.getElementById("forumPostBtn").addEventListener("click", async () => {
  const btn = document.getElementById("forumPostBtn");
  setLoading(btn, true, "Writing...", "Write Forum Post");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "writeForumPost" }, (response) => {
    setLoading(btn, false, "", "Write Forum Post");
    if (chrome.runtime.lastError || !response) {
      showResult("Please refresh the Coursera page first.", "error");
    } else if (response.error) {
      showResult(response.error, "error");
    } else {
      showResult("Forum post written on the page!", "success");
    }
  });
});

document.getElementById("codesolveBtn").addEventListener("click", async () => {
  const btn = document.getElementById("codesolveBtn");
  setLoading(btn, true, "Solving...", "Solve Coding Task");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "solveCodingAssignment" }, (response) => {
    setLoading(btn, false, "", "Solve Coding Task");
    if (chrome.runtime.lastError || !response) {
      showResult("Please refresh the Coursera page first.", "error");
    } else if (response.error) {
      showResult(response.error, "error");
    } else {
      showResult("Code solution opened on the page!", "success");
    }
  });
});

document.getElementById("transcriptQABtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "openTranscriptQA" }, () => {
    if (chrome.runtime.lastError) showResult("Please refresh the Coursera page first.", "error");
    else showResult("Q&A panel opened on the page!", "success");
  });
});

document.getElementById("autopilotBtn").addEventListener("click", async () => {
  const btn = document.getElementById("autopilotBtn");
  setLoading(btn, true, "Starting...", "Autopilot Mode");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "startAutopilot" }, (response) => {
    setLoading(btn, false, "", "Autopilot Mode");
    if (chrome.runtime.lastError || !response) {
      showResult("Please refresh the Coursera page first.", "error");
    } else if (response.error) {
      showResult(response.error, "error");
    } else {
      showResult("Autopilot started! The extension will navigate the course for you.", "success");
    }
  });
});

document.getElementById("specCompleteBtn").addEventListener("click", async () => {
  const btn = document.getElementById("specCompleteBtn");
  setLoading(btn, true, "Working...", "Complete Specialization");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "completeSpecialization" }, (response) => {
    setLoading(btn, false, "", "Complete Specialization");
    if (chrome.runtime.lastError || !response) {
      showResult("Please refresh the Coursera page first.", "error");
    } else {
      showResult("Specialization completion started! Watch the banner.", "success");
    }
  });
});

document.getElementById("loadCoursesBtn").addEventListener("click", async () => {
  const btn = document.getElementById("loadCoursesBtn");
  setLoading(btn, true, "Loading...", "Load My Enrolled Courses");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "loadEnrolledCourses" }, (response) => {
    setLoading(btn, false, "", "Load My Enrolled Courses");
    if (chrome.runtime.lastError || !response) {
      showResult("Open a Coursera course page first, then try again.", "error");
      return;
    }
    if (response.error) { showResult(response.error, "error"); return; }

    const courses = response.courses || [];
    if (courses.length === 0) { showResult("No courses found. Make sure you're logged in and on a Coursera course page, then try again.", "error"); return; }

    const courseList = document.getElementById("courseList");
    courseList.innerHTML = "";
    courses.forEach(course => {
      const label = document.createElement("label");
      label.className = "week-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = course.id;
      cb.checked = true;
      cb.dataset.name = course.name;
      label.appendChild(cb);
      label.appendChild(document.createTextNode(course.name));
      courseList.appendChild(label);
    });

    courseList.style.display = "flex";
    document.getElementById("walkAwayBtns").style.display = "flex";
    showResult(`Found ${courses.length} enrolled courses. Select which to complete.`, "success");
  });
});

document.getElementById("startWalkAwayBtn").addEventListener("click", async () => {
  const courseList = document.getElementById("courseList");
  const checkboxes = courseList.querySelectorAll("input[type='checkbox']:checked");
  const selectedCourses = Array.from(checkboxes).map(cb => ({ id: cb.value, name: cb.dataset.name || cb.value }));

  if (selectedCourses.length === 0) {
    showResult("Select at least one course.", "error");
    return;
  }

  await chrome.storage.local.set({
    walkAwayActive: true,
    walkAwayCourses: selectedCourses,
    walkAwayIndex: 0
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.update(tab.id, { url: `https://www.coursera.org/learn/${selectedCourses[0].id}` });

  const startBtn = document.getElementById("startWalkAwayBtn");
  startBtn.disabled = true;
  startBtn.textContent = "Running...";
  document.getElementById("walkAwayStatus").textContent = `Walk-Away started — ${selectedCourses.length} courses queued. You can close this popup.`;
  showResult(`Walk-Away active! Completing ${selectedCourses.length} courses automatically.`, "success");
});

document.getElementById("stopWalkAwayBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({ walkAwayActive: false });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "stopWalkAway" }, () => {});
  const startBtn = document.getElementById("startWalkAwayBtn");
  startBtn.disabled = false;
  startBtn.textContent = "Start Walk-Away";
  document.getElementById("walkAwayStatus").textContent = "";
  showResult("Walk-Away stopped.", "success");
});

document.getElementById("speedRunBtn").addEventListener("click", async () => {
  const btn = document.getElementById("speedRunBtn");
  setLoading(btn, true, "Analyzing...", "Speed-Run Analyzer");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: "analyzeSpeedRun" }, (response) => {
    setLoading(btn, false, "", "Speed-Run Analyzer");
    if (chrome.runtime.lastError || !response) {
      showResult("Please refresh the Coursera page first.", "error");
    } else if (response.error) {
      showResult(response.error, "error");
    } else {
      const est = Math.ceil(response.required * 2);
      showResult(
        `Total: ${response.total} items  |  Required: ${response.required} quizzes  |  Skippable: ${response.skippable}\nFinal exam: ${response.finalExam}\nLocked: ${response.locked}  |  Est. time: ~${est} min`,
        "success"
      );
    }
  });
});
