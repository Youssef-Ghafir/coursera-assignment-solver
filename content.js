let capturedUserId = null;
let capturedCourseId = null;
let capturedAuthToken = null;

const answerCache = {};
let currentTranscript = null;
let tutorContext = null;
let chatHistory = [];

window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.source !== "auto-coursera-interceptor") {
        return;
    }

    const { url, contentType, response, request } = event.data;

    if (response && response.context && response.context.dispatcher) {
        try {
            capturedUserId = response.context.dispatcher.stores.ApplicationStore.userData.id;
        } catch (e) { }
    }

    if (!capturedUserId && request && request.url) {
        const userMatch = request.url.match(/user\/([0-9]+)/) || request.url.match(/userId=([0-9]+)/);
        if (userMatch) {
            capturedUserId = userMatch[1];
        }
    }

    if (request && request.headers && request.headers.length > 0) {
        request.headers.forEach(header => {
            if (header[0].toLowerCase() === 'x-csrf3-token') {
                capturedAuthToken = header[1];
            }
        });
    }

    if (request && request.url && (request.url.includes("api/onDemandCourses.v1") || request.url.includes("slug="))) {
        const urlParams = new URL(request.url).searchParams;
        if (urlParams.has("slug")) {
            capturedCourseId = urlParams.get("slug");
        }
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getTokenStatus") {
        sendResponse({
            hasToken: !!capturedAuthToken,
            hasCourseId: !!capturedCourseId || !!window.location.pathname.match(/\/learn\/([^/]+)/)
        });
        return true;
    }

    if (request.action === "loadCourseWeeks") {
        (async () => {
            // Resolve courseId from captured or URL
            let courseId = capturedCourseId;
            if (!courseId) {
                const m = window.location.pathname.match(/\/learn\/([^/]+)/);
                if (m) courseId = m[1];
            }

            if (!capturedAuthToken) {
                sendResponse({ error: "Missing Auth Token! Please click around the course to grab security tokens." });
                return;
            }
            if (!courseId) {
                sendResponse({ error: "Missing Course ID! Please go to the main course page." });
                return;
            }

            try {
                const courseDataUrl = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${courseId}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(name,lessonIds,optional),onDemandCourseMaterialLessons.v1(elementIds,optional,itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary)`;
                const resp = await fetch(courseDataUrl, {
                    headers: { "X-CSRF3-Token": capturedAuthToken }
                });
                const data = await resp.json();

                const modules = [];
                if (data && data.linked && data.linked['onDemandCourseMaterialModules.v1']) {
                    data.linked['onDemandCourseMaterialModules.v1'].forEach(mod => {
                        modules.push({ id: mod.id, name: mod.name || mod.id });
                    });
                } else if (data && data.elements && data.elements[0] && data.elements[0].modules) {
                    data.elements[0].modules.forEach(mod => {
                        modules.push({ id: mod.id, name: mod.name || mod.id });
                    });
                }

                sendResponse({ modules });
            } catch (e) {
                sendResponse({ error: e.message || "Failed to load course weeks." });
            }
        })();
        return true;
    }

    if (request.action === "applyStoredAnswers") {
        chrome.storage.local.get(['toggleHumanStyle', 'toggleAutoSubmit'], (storageResult) => {
            const humanStyle = !!storageResult.toggleHumanStyle;
            const applied = applyAnswersToDOM(request.data, humanStyle);
            sendResponse({ status: applied !== false ? "applied" : "already_correct" });
            if (applied !== false && storageResult.toggleAutoSubmit && !humanStyle) {
                attemptAutoSubmit();
            }
        });
        return true;
    }

    if (request.action === "solveQuizDirectly") {
        sendResponse({ status: "started" });
        showOrUpdateBanner("Analyzing questions...", "info");

        const arrayQuestions = scrapeAssessment();

        if (!arrayQuestions || arrayQuestions.length === 0) {
            showOrUpdateBanner("No questions found on this page! Are you on a quiz?", "error");
            setTimeout(hideBanner, 4000);
            return;
        }

        const cacheKey = window.location.pathname + window.location.search;
        if (answerCache[cacheKey]) {
            const humanStyle = request.humanStyle || false;
            const applied = applyAnswersToDOM(answerCache[cacheKey], humanStyle);
            if (applied !== false) {
                showOrUpdateBanner("Answers loaded from cache! ✅", "success");
                setTimeout(hideBanner, humanStyle ? 8000 : 3000);
                chrome.storage.local.get(['toggleAutoSubmit'], (sr) => {
                    if (sr.toggleAutoSubmit) setTimeout(attemptAutoSubmit, humanStyle ? 2000 : 500);
                });
                if (!humanStyle) setTimeout(() => checkAndRetryIfWrong(answerCache[cacheKey], humanStyle), 4500);
            }
            return;
        }

        chrome.runtime.sendMessage(
            {
                action: "fetchAIExplanation",
                text: arrayQuestions,
                withExplanations: request.withExplanations || false,
                humanStyle: request.humanStyle || false,
                customInstructions: request.customInstructions || ""
            },
            (aiResponse) => {
                if (aiResponse && aiResponse.error) {
                    showOrUpdateBanner("Error: " + aiResponse.error, "error");
                    setTimeout(hideBanner, 5000);
                } else if (aiResponse && aiResponse.result) {
                    answerCache[cacheKey] = aiResponse.result;
                    const humanStyle = request.humanStyle || false;
                    if (window.location.hostname.includes('skills.network')) {
                        applyAnswersGeneric(aiResponse.result);
                    } else {
                        const applied = applyAnswersToDOM(aiResponse.result, humanStyle);
                        if (applied !== false) {
                            showOrUpdateBanner("Answers applied successfully! ✅", "success");
                            setTimeout(hideBanner, humanStyle ? 8000 : 4000);
                            chrome.storage.local.get(['toggleAutoSubmit'], (storageResult) => {
                                if (storageResult.toggleAutoSubmit) setTimeout(attemptAutoSubmit, humanStyle ? 2000 : 0);
                            });
                            if (!humanStyle) setTimeout(() => checkAndRetryIfWrong(aiResponse.result, humanStyle), 4500);
                        }
                    }
                } else {
                    showOrUpdateBanner("An unknown error occurred.", "error");
                    setTimeout(hideBanner, 4000);
                }
            }
        );
    }

    if (request.action === "getSelection") {
        const arrayQuestions = scrapeAssessment();
        sendResponse({ data: arrayQuestions });
    }

    if (request.action === "clearCache") {
        Object.keys(answerCache).forEach(k => delete answerCache[k]);
        sendResponse({ ok: true });
    }

    if (request.action === "generateFlashcards") {
        sendResponse({ ok: true });
        triggerFlashcards();
    }

    if (request.action === "fillPeerReview") {
        handleFillPeerReview(sendResponse);
        return true;
    }

    if (request.action === "startAutopilot") {
        handleStartAutopilot(sendResponse);
        return true;
    }

    if (request.action === "stopAutopilot") {
        chrome.storage.local.set({ autopilotActive: false });
        const stopBtn = document.getElementById("autopilot-stop-btn");
        if (stopBtn) stopBtn.remove();
        hideBanner();
        sendResponse({ ok: true });
    }

    if (request.action === "completeSpecialization") {
        sendResponse({ status: "started" });
        handleCompleteSpecialization();
    }

    if (request.action === "openTranscriptQA") {
        sendResponse({ ok: true });
        handleOpenTranscriptQA();
    }

    if (request.action === "writeForumPost") {
        handleWriteForumPost(sendResponse);
        return true;
    }

    if (request.action === "analyzeSpeedRun") {
        handleAnalyzeSpeedRun(sendResponse);
        return true;
    }

    if (request.action === "solveCodingAssignment") {
        handleSolveCodingAssignment(sendResponse);
        return true;
    }

    if (request.action === "loadEnrolledCourses") {
        loadEnrolledCourses().then(result => sendResponse(result)).catch(e => sendResponse({ error: e.message }));
        return true;
    }

    if (request.action === "startFullCourse") {
        if (!capturedCourseId) {
            const m = window.location.pathname.match(/\/learn\/([^/]+)/);
            if (m) capturedCourseId = m[1];
        }
        if (!capturedAuthToken) {
            sendResponse({ error: "Missing auth token. Browse the course a bit first." });
            return true;
        }
        if (!capturedCourseId) {
            sendResponse({ error: "Missing course ID. Go to the main course page first." });
            return true;
        }
        sendResponse({ status: "started" });
        startFullCourse();
    }

    if (request.action === "stopQuizPilot") {
        chrome.storage.local.set({ quizPilotActive: false });
        hideBanner();
        const btn = document.getElementById("quiz-pilot-stop-btn");
        if (btn) btn.remove();
        sendResponse({ ok: true });
    }

    if (request.action === "stopWalkAway") {
        chrome.storage.local.set({ walkAwayActive: false });
        hideBanner();
        const stopBtn = document.getElementById("walk-away-stop-btn");
        if (stopBtn) stopBtn.remove();
        sendResponse({ ok: true });
    }

    if (request.action === "completeVideos") {
        if (!capturedCourseId) {
            const matchUrl = window.location.pathname.match(/\/learn\/([^/]+)/);
            if (matchUrl) {
                capturedCourseId = matchUrl[1];
            }
        }

        if (!capturedAuthToken) {
            sendResponse({ error: "Missing Auth Token! Please click around the course (e.g., refresh or open a new video) to grab background security tokens." });
            return true;
        }
        if (!capturedCourseId) {
            sendResponse({ error: "Missing Course ID! Please go to the main course page to grab your Course ID." });
            return true;
        }

        sendResponse({ status: "started" });
        startCompletionLoop(request.moduleIds || null);
    }

    return true;
});

function getQuestionBlocks() {
    const seen = new Set();
    const blocks = [];

    document.querySelectorAll('[id^="prompt-"]').forEach(promptEl => {
        let el = promptEl.parentElement;
        for (let depth = 0; depth < 10 && el && el !== document.body; depth++) {
            const isNamedQuestion = el.dataset.testid && el.dataset.testid.startsWith('part-');
            const hasAnswerArea = el.querySelector('.rc-Option, input:not([type="hidden"]), textarea, [data-slate-editor="true"]');
            if (isNamedQuestion || hasAnswerArea) {
                if (!seen.has(el)) {
                    seen.add(el);
                    blocks.push(el);
                }
                break;
            }
            el = el.parentElement;
        }
    });

    return blocks;
}

function scrapeAssessment() {
    const scrapedAssessment = [];
    const questionBlocks = getQuestionBlocks();

    questionBlocks.forEach((block, index) => {
        const promptNode = block.querySelector('[id^="prompt-"] [data-testid="cml-viewer"]');
        if (!promptNode) return;

        const questionText = promptNode.innerText.trim();
        const options = [];
        let questionType = 'unknown';

        const optionNodes = block.querySelectorAll('.rc-Option');

        if (optionNodes.length > 0) {
            optionNodes.forEach(opt => {
                const textNode = opt.querySelector('[data-testid="cml-viewer"]');
                const inputNode = opt.querySelector('input');

                if (textNode && inputNode) {
                    options.push(textNode.innerText.trim());
                    if (questionType === 'unknown') {
                        questionType = inputNode.type === 'radio' ? 'single_answer' : 'multiple_answer';
                    }
                }
            });
        } else {
            const standardInput = block.querySelector('input[type="text"], input:not([type="radio"]):not([type="checkbox"]), textarea');
            const slateEditor = block.querySelector('[data-slate-editor="true"]');

            if (slateEditor) {
                questionType = 'essay';
            } else if (standardInput) {
                questionType = 'text_input';
            }
        }

        scrapedAssessment.push({
            questionNumber: index + 1,
            type: questionType,
            question: questionText,
            options: options
        });
    });

    if (scrapedAssessment.length > 0) return scrapedAssessment;

    // Generic fallback for Skills Network and other platforms
    return scrapeGenericAssessment();
}

function scrapeGenericAssessment() {
    const questions = [];
    let qNum = 0;

    // Group radio buttons by name attribute — most reliable for MC
    const radioGroups = new Map();
    document.querySelectorAll('input[type="radio"]').forEach(r => {
        const key = r.name || r.getAttribute('data-name') || 'group_' + radioGroups.size;
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(r);
    });

    radioGroups.forEach((radios) => {
        qNum++;
        const anchor = radios[0];
        let questionText = `Question ${qNum}`;

        let el = anchor.parentElement;
        for (let i = 0; i < 10 && el && el !== document.body; i++) {
            const prompt = el.querySelector('p, legend, h2, h3, h4, .question-text, [class*="question"], [class*="prompt"], [class*="title"]');
            if (prompt && prompt.innerText.trim() && !prompt.querySelector('input')) {
                questionText = prompt.innerText.trim().split('\n')[0].trim();
                break;
            }
            el = el.parentElement;
        }

        const options = radios.map(r => {
            const lbl = document.querySelector(`label[for="${r.id}"]`) || r.closest('label');
            const raw = lbl ? lbl.innerText.trim() : (r.value || '');
            // Strip leading radio-like characters
            return raw.replace(/^[○●◯•]\s*/, '').trim();
        }).filter(t => t);

        questions.push({ questionNumber: qNum, type: 'single_answer', question: questionText, options });
    });

    const checkParents = new Map();
    document.querySelectorAll('input[type="checkbox"]').forEach(c => {
        const parent = c.closest('fieldset') || c.closest('[class*="question"]') || c.closest('form') || c.parentElement?.parentElement;
        const key = parent || 'root';
        if (!checkParents.has(key)) checkParents.set(key, []);
        checkParents.get(key).push(c);
    });

    checkParents.forEach((checks, parent) => {
        if (checks.length < 2) return; // skip lone checkboxes (likely toggles)
        qNum++;
        let questionText = `Question ${qNum}`;
        if (parent && parent !== 'root') {
            const prompt = parent.querySelector('p, legend, h3, h4, .question-text');
            if (prompt && prompt.innerText.trim()) questionText = prompt.innerText.trim().split('\n')[0];
        }
        const options = checks.map(c => {
            const lbl = document.querySelector(`label[for="${c.id}"]`) || c.closest('label');
            return lbl ? lbl.innerText.trim() : (c.value || '');
        }).filter(t => t);
        questions.push({ questionNumber: qNum, type: 'multiple_answer', question: questionText, options });
    });

    document.querySelectorAll('textarea, input[type="text"]').forEach(inp => {
        if (inp.readOnly || inp.disabled) return;
        qNum++;
        const container = inp.closest('fieldset') || inp.closest('[class*="question"]') || inp.closest('section') || inp.parentElement;
        const prompt = container ? container.querySelector('p, label, h3, h4') : null;
        const questionText = prompt ? prompt.innerText.trim() : `Question ${qNum}`;
        questions.push({ questionNumber: qNum, type: 'text_input', question: questionText, options: [] });
    });

    return questions;
}

async function applyAnswersGeneric(answers) {
    const isStealthSite = window.location.hostname.includes('skills.network');

    const stealthPause = (min, max) => new Promise(r =>
        setTimeout(r, isStealthSite ? (min + Math.random() * (max - min)) : 200)
    );

    showOrUpdateBanner("Applying answers...", "info");

    if (isStealthSite) await stealthPause(2500, 5000);

    const radioGroups = new Map();
    document.querySelectorAll('input[type="radio"]').forEach(r => {
        const key = r.name || 'group_' + radioGroups.size;
        if (!radioGroups.has(key)) radioGroups.set(key, []);
        radioGroups.get(key).push(r);
    });

    let gi = 0;
    for (const [, radios] of radioGroups) {
        gi++;
        const ans = answers.find(a => a.questionNumber === gi);
        if (!ans || !ans.correctOptions) continue;

        for (const r of radios) {
            const lbl = document.querySelector(`label[for="${r.id}"]`) || r.closest('label');
            const text = (lbl ? lbl.innerText.trim() : r.value).replace(/^[○●◯•]\s*/, '').trim();
            const match = ans.correctOptions.some(c =>
                text === c || text.includes(c) || c.includes(text)
            );
            if (match && !r.checked) {
                await stealthPause(800, 2200);
                r.click();
                r.dispatchEvent(new Event('change', { bubbles: true }));
                break;
            }
        }
    }

    const checkParents = new Map();
    document.querySelectorAll('input[type="checkbox"]').forEach(c => {
        const parent = c.closest('fieldset') || c.closest('[class*="question"]') || c.parentElement?.parentElement || 'root';
        if (!checkParents.has(parent)) checkParents.set(parent, []);
        checkParents.get(parent).push(c);
    });

    let ci = gi;
    for (const [, checks] of checkParents) {
        if (checks.length < 2) continue;
        ci++;
        const ans = answers.find(a => a.questionNumber === ci);
        if (!ans || !ans.correctOptions) continue;
        for (const c of checks) {
            const lbl = document.querySelector(`label[for="${c.id}"]`) || c.closest('label');
            const text = lbl ? lbl.innerText.trim() : c.value;
            const match = ans.correctOptions.some(opt => text === opt || text.includes(opt) || opt.includes(text));
            if (match && !c.checked) {
                await stealthPause(600, 1800);
                c.click();
                c.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }

    const textInputs = [...document.querySelectorAll('textarea, input[type="text"]')].filter(i => !i.readOnly && !i.disabled);
    let ti = ci;
    for (const inp of textInputs) {
        ti++;
        const ans = answers.find(a => a.questionNumber === ti);
        if (!ans || !ans.correctOptions[0]) continue;
        await stealthPause(1000, 3000);
        inp.focus();
        inp.value = '';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.value = ans.correctOptions[0];
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        inp.blur();
    }

    await stealthPause(3000, 6000);
    attemptGenericSubmit();

    showOrUpdateBanner("Done! ✅", "success");
    setTimeout(hideBanner, 4000);
}

function attemptGenericSubmit() {
    const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(b => {
        const t = (b.innerText || b.value || '').toLowerCase().trim();
        return t.includes('grade') || t.includes('submit') || t.includes('check answer') || t.includes('done') || t.includes('finish');
    });
    if (btn && !btn.disabled) btn.click();
}

function applyAnswersToDOM(correctAnswers, humanTyping = false) {
    const questionBlocks = getQuestionBlocks();

    let allAlreadyCorrect = true;
    let anyAnswerChecked = false;
    questionBlocks.forEach((block, index) => {
        const currentQuestionNumber = index + 1;
        const answerData = correctAnswers.find(q => q.questionNumber === currentQuestionNumber);
        if (!answerData || !answerData.correctOptions || answerData.correctOptions.length === 0) return;
        anyAnswerChecked = true;

        const optionNodes = block.querySelectorAll('.rc-Option');
        if (optionNodes.length > 0) {
            answerData.correctOptions.forEach(correctOption => {
                let found = false;
                optionNodes.forEach(opt => {
                    const textNode = opt.querySelector('[data-testid="cml-viewer"]');
                    const inputNode = opt.querySelector('input');
                    if (textNode && inputNode && textNode.innerText.trim() === correctOption) {
                        if (!inputNode.checked) allAlreadyCorrect = false;
                        found = true;
                    }
                });
                if (!found) allAlreadyCorrect = false;
            });
        } else {
            allAlreadyCorrect = false;
        }
    });

    if (allAlreadyCorrect && anyAnswerChecked) {
        showOrUpdateBanner("Already answered correctly ✅", "success");
        setTimeout(hideBanner, 3000);
        return false;
    }

    questionBlocks.forEach((block, index) => {
        const currentQuestionNumber = index + 1;
        const answerData = correctAnswers.find(q => q.questionNumber === currentQuestionNumber);

        if (!answerData || !answerData.correctOptions || answerData.correctOptions.length === 0) return;

        const optionNodes = block.querySelectorAll('.rc-Option');

        if (optionNodes.length > 0) {
            optionNodes.forEach(opt => {
                const textNode = opt.querySelector('[data-testid="cml-viewer"]');
                const inputNode = opt.querySelector('input');

                if (textNode && inputNode) {
                    const optionText = textNode.innerText.trim();
                    const shouldBeSelected = answerData.correctOptions.includes(optionText);

                    if (shouldBeSelected && !inputNode.checked) {
                        inputNode.click();
                    } else if (!shouldBeSelected && inputNode.checked && inputNode.type === 'checkbox') {
                        inputNode.click();
                    }
                }
            });
        } else {
            const textInputNode = block.querySelector('input[type="text"], input:not([type="radio"]):not([type="checkbox"]), textarea, [data-slate-editor="true"]');

            if (textInputNode) {
                const textToType = answerData.correctOptions[0];

                if (humanTyping) {
                    simulateHumanTyping(textInputNode, textToType);
                } else if (textInputNode.hasAttribute('contenteditable')) {
                    textInputNode.focus();
                    setTimeout(() => {
                        document.execCommand('selectAll', false, null);
                        document.execCommand('insertText', false, textToType);
                    }, 50);
                } else {
                    textInputNode.value = textToType;
                    textInputNode.dispatchEvent(new Event('input', { bubbles: true }));
                    textInputNode.dispatchEvent(new Event('change', { bubbles: true }));
                }
            }
        }
    });

    return true;
}

async function simulateHumanTyping(element, text) {
    const isContentEditable = element.hasAttribute('contenteditable');
    showOrUpdateBanner("Writing your response... ✍️", "info");

    if (isContentEditable) {
        element.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        for (const char of text) {
            document.execCommand('insertText', false, char);
            await new Promise(r => setTimeout(r, 30 + Math.random() * 70));
            if (Math.random() < 0.025) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
            }
        }
    } else {
        element.focus();
        element.value = '';
        element.dispatchEvent(new Event('input', { bubbles: true }));
        for (const char of text) {
            element.value += char;
            element.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 30 + Math.random() * 70));
            if (Math.random() < 0.025) {
                await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
            }
        }
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    showOrUpdateBanner("Response written! ✅", "success");
    setTimeout(hideBanner, 4000);
}

function attemptAutoSubmit() {
    const selectors = [
        '[data-testid="submission-cta-btn"]',
        '[data-testid="submit-button"]',
        'button[aria-label*="submit" i]',
    ];
    for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn && !btn.disabled) { btn.click(); return true; }
    }
    for (const btn of document.querySelectorAll('button')) {
        const t = btn.innerText.trim().toLowerCase();
        if ((t === 'submit' || t === 'grade my quiz' || t === 'grade quiz') && !btn.disabled) {
            btn.click(); return true;
        }
    }
    return false;
}

function showOrUpdateBanner(text, type = "info") {
    let banner = document.getElementById("auto-coursera-banner");
    if (!banner) {
        banner = document.createElement("div");
        banner.id = "auto-coursera-banner";
        banner.style.position = "fixed";
        banner.style.bottom = "30px";
        banner.style.left = "50%";
        banner.style.transform = "translateX(-50%)";
        banner.style.zIndex = "9999999";
        banner.style.padding = "16px 32px";
        banner.style.color = "white";
        banner.style.fontWeight = "bold";
        banner.style.borderRadius = "50px";
        banner.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
        banner.style.fontFamily = "ui-sans-serif, system-ui, -apple-system, sans-serif";
        banner.style.fontSize = "16px";
        banner.style.transition = "opacity 0.3s ease";
        banner.style.display = "flex";
        banner.style.alignItems = "center";
        document.body.appendChild(banner);
    }

    if (!banner.querySelector('.auto-coursera-close-btn')) {
        const closeBtn = document.createElement('button');
        closeBtn.className = 'auto-coursera-close-btn';
        closeBtn.innerHTML = '×';
        closeBtn.style.cssText = 'background:none;border:none;color:white;font-size:20px;cursor:pointer;margin-left:16px;opacity:0.8;line-height:1;padding:0;vertical-align:middle;';
        closeBtn.onclick = hideBanner;
        banner.appendChild(closeBtn);
    }

    const closeBtn = banner.querySelector('.auto-coursera-close-btn');

    if (type === "success") {
        banner.style.backgroundColor = "#16a34a";
        const msgSpan = document.createElement('span');
        msgSpan.textContent = "✅ " + text;
        while (banner.firstChild && banner.firstChild !== closeBtn) {
            banner.removeChild(banner.firstChild);
        }
        banner.insertBefore(msgSpan, closeBtn);
    } else if (type === "error") {
        banner.style.backgroundColor = "#ef4444";
        const msgSpan = document.createElement('span');
        msgSpan.textContent = "❌ " + text;
        while (banner.firstChild && banner.firstChild !== closeBtn) {
            banner.removeChild(banner.firstChild);
        }
        banner.insertBefore(msgSpan, closeBtn);
    } else {
        banner.style.backgroundColor = "#2563eb";

        if (!document.getElementById("auto-coursera-styles")) {
            const style = document.createElement("style");
            style.id = "auto-coursera-styles";
            style.innerHTML = `@keyframes spin { 100% { transform: rotate(360deg); } }`;
            document.head.appendChild(style);
        }

        const msgSpan = document.createElement('span');
        const spinner = document.createElement('span');
        spinner.style.cssText = 'display:inline-block; margin-right:8px; animation: spin 1s linear infinite;';
        spinner.textContent = '⏳';
        msgSpan.appendChild(spinner);
        msgSpan.appendChild(document.createTextNode(text));

        while (banner.firstChild && banner.firstChild !== closeBtn) {
            banner.removeChild(banner.firstChild);
        }
        banner.insertBefore(msgSpan, closeBtn);
    }

    banner.style.opacity = "1";
}

function hideBanner() {
    const banner = document.getElementById("auto-coursera-banner");
    if (banner) {
        banner.style.opacity = "0";
        setTimeout(() => banner.remove(), 300);
    }
}




async function startCompletionLoop(moduleIds = null, { skipSignal = false } = {}) {
    showOrUpdateBanner("Loading course...", "info");

    const settings = await new Promise(r => chrome.storage.local.get(['toggleADHDNotes'], r));

    try {
        const courseDataRes = await fetch(
            `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${capturedCourseId}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(name,lessonIds,optional),onDemandCourseMaterialLessons.v1(elementIds,optional,itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary)`,
            { headers: { "X-CSRF3-Token": capturedAuthToken, "Referer": `https://www.coursera.org/learn/${capturedCourseId}` } }
        );
        const courseData = await courseDataRes.json();

        let internalCourseId = capturedCourseId;
        if (courseData.elements && courseData.elements[0] && courseData.elements[0].id) {
            internalCourseId = courseData.elements[0].id;
        }

        let lockedCount = 0;
        if (courseData.linked && courseData.linked['onDemandCourseMaterialItems.v2']) {
            courseData.linked['onDemandCourseMaterialItems.v2'].forEach(i => { if (i.isLocked) lockedCount++; });
        }

        let items = extractVideoAndReadingIds(courseData);

        if (moduleIds && moduleIds.length > 0) {
            const allowed = new Set();
            const mods = (courseData.linked && courseData.linked['onDemandCourseMaterialModules.v1']) || [];
            const lessons = (courseData.linked && courseData.linked['onDemandCourseMaterialLessons.v1']) || [];
            const lessonMap = {};
            lessons.forEach(l => { lessonMap[l.id] = l.itemIds || []; });
            mods.forEach(m => {
                if (moduleIds.includes(m.id)) {
                    (m.lessonIds || []).forEach(lid => (lessonMap[lid] || []).forEach(id => allowed.add(id)));
                }
            });
            items = items.filter(it => allowed.has(it.id));
        }

        if (!items.length) {
            showOrUpdateBanner("No completable items found. Try refreshing the page first.", "error");
            setTimeout(hideBanner, 5000);
            return;
        }

        const uid = capturedUserId || "~";
        const numUid = parseInt(uid);
        const h = { "Content-Type": "application/json", "X-CSRF3-Token": capturedAuthToken };
        const BATCH = 6;

        for (let i = 0; i < items.length; i += BATCH) {
            const batch = items.slice(i, i + BATCH);
            showOrUpdateBanner(`Completing ${i + 1}–${Math.min(i + BATCH, items.length)} of ${items.length}...`);
            await Promise.all(batch.map(({ id: itemId }) => Promise.all([
                fetch(`https://www.coursera.org/api/opencourse.v1/user/${uid}/course/${capturedCourseId}/item/${itemId}/lecture/videoEvents/ended?autoEnroll=false`, {
                    method: "POST", headers: h, body: '{"contentRequestBody":{}}'
                }).catch(() => {}),
                fetch(`https://www.coursera.org/api/onDemandSupplementCompletions.v1`, {
                    method: "POST", headers: h,
                    body: JSON.stringify({ userId: isNaN(numUid) ? uid : numUid, courseId: internalCourseId, itemId })
                }).catch(() => {})
            ])));
            await new Promise(r => setTimeout(r, 400));
        }

        showOrUpdateBanner(`Done! ${items.length} items sent. Refresh the page to see your progress.`, "success");
        setTimeout(hideBanner, 8000);

        chrome.runtime.sendMessage({ action: "notifyCompletion", count: items.length, locked: lockedCount });
        if (settings.toggleADHDNotes) triggerADHDNotes(items);
        if (!skipSignal) chrome.runtime.sendMessage({ action: "walkAwayCourseDone" });

    } catch (err) {
        showOrUpdateBanner("An error occurred. Please try again.", "error");
        setTimeout(hideBanner, 5000);
    }
}

async function loadEnrolledCourses() {
    if (!capturedAuthToken) return { error: "Missing auth token. Click around the course first to activate." };

    const headers = { "X-CSRF3-Token": capturedAuthToken, "Referer": "https://www.coursera.org/my-learning" };
    const uid = capturedUserId || "~";

    const endpoints = [
        `https://www.coursera.org/api/memberships.v1?q=me&includes=courses.v1&fields=courses.v1(name,slug)&limit=100`,
        `https://www.coursera.org/api/memberships.v1?userId=${uid}&includes=courses.v1&fields=courses.v1(name,slug)&limit=100`,
        `https://www.coursera.org/api/memberships.v1?userId=~&includes=courses.v1&fields=courses.v1(name,slug)&limit=100`,
    ];

    for (const url of endpoints) {
        try {
            const res = await fetch(url, { headers });
            if (!res.ok) continue;
            const data = await res.json();
            const linked = (data.linked && data.linked['courses.v1']) || [];
            const courses = linked
                .filter(c => c.slug && c.name)
                .map(c => ({ id: c.slug, name: c.name }));
            if (courses.length > 0) return { courses };
        } catch (e) {}
    }

    return { error: "No courses found. Make sure you're logged into Coursera and have enrolled in at least one course." };
}

async function triggerADHDNotes(itemsToComplete) {
    showOrUpdateBanner("Fetching course readings... 📚", "info");

    const supplements = itemsToComplete.filter(i => i.type === 'supplement').slice(0, 12);

    const results = await Promise.all(supplements.map(async (item) => {
        try {
            const res = await fetch(
                `https://www.coursera.org/api/onDemandSupplements.v1/${item.id}?includes=asset&fields=onDemandSupplements.v1(name,typedAsset)`,
                { headers: { "X-CSRF3-Token": capturedAuthToken } }
            );
            const data = await res.json();
            if (data.elements?.[0]) {
                const el = data.elements[0];
                const html = el.typedAsset?.definition?.value || '';
                const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (text) return { name: el.name || item.id, text: text.slice(0, 1800) };
            }
        } catch(e) {}
        return null;
    }));

    const contents = results.filter(Boolean);

    showOrUpdateBanner("Generating ADHD study notes... this takes ~30s 📚", "info");

    chrome.runtime.sendMessage({
        action: "generateADHDNotes",
        courseId: capturedCourseId,
        contents
    }, (resp) => {
        if (resp?.error) {
            showOrUpdateBanner("Notes failed: " + resp.error, "error");
            setTimeout(hideBanner, 8000);
        } else {
            showOrUpdateBanner("ADHD notes ready! Opening in new tab. 📚", "success");
            setTimeout(hideBanner, 4000);
        }
    });
}

function checkAndRetryIfWrong(prevAnswers, humanStyle, attempt) {
    attempt = attempt || 1;
    if (attempt > 1) return;
    const wrongIndicator = document.querySelector(
        '[data-testid="incorrect-feedback"], .rc-IncorrectFeedback, [class*="incorrect-feedback"]'
    );
    if (!wrongIndicator) return;
    showOrUpdateBanner("Wrong answer detected, retrying... 🔄", "info");
    const freshQuestions = scrapeAssessment().map(q => {
        const prev = prevAnswers.find(p => p.questionNumber === q.questionNumber);
        if (prev) q.triedOptions = prev.correctOptions || [];
        return q;
    });
    chrome.runtime.sendMessage({ action: "fetchAIExplanation", text: freshQuestions }, (aiResponse) => {
        if (aiResponse && aiResponse.result) {
            applyAnswersToDOM(aiResponse.result, humanStyle);
            showOrUpdateBanner("Retry applied! ✅", "success");
            setTimeout(hideBanner, 3000);
            setTimeout(attemptAutoSubmit, 500);
        }
    });
}

async function triggerFlashcards() {
    showOrUpdateBanner("Fetching course content for flashcards... 📇", "info");
    if (!capturedCourseId) {
        const m = window.location.pathname.match(/\/learn\/([^/]+)/);
        if (m) capturedCourseId = m[1];
    }
    if (!capturedCourseId) {
        showOrUpdateBanner("Could not detect course ID.", "error");
        setTimeout(hideBanner, 4000);
        return;
    }
    try {
        const contents = await fetchSupplementContents(8, 1500);
        chrome.runtime.sendMessage({ action: "generateFlashcardsAI", courseId: capturedCourseId, contents }, () => {
            showOrUpdateBanner("Flashcard viewer opening... 📇", "success");
            setTimeout(hideBanner, 3000);
        });
    } catch (e) {
        showOrUpdateBanner("Error fetching content for flashcards.", "error");
        setTimeout(hideBanner, 4000);
    }
}

async function fetchSupplementContents(maxItems, maxChars) {
    const courseDataUrl = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${capturedCourseId}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(lessonIds),onDemandCourseMaterialLessons.v1(itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary)`;
    const res = await fetch(courseDataUrl, { headers: capturedAuthToken ? { "X-CSRF3-Token": capturedAuthToken } : {} });
    const courseData = await res.json();
    const items = (courseData.linked && courseData.linked['onDemandCourseMaterialItems.v2']) || [];
    const supplements = items.filter(i => {
        const t = (i.contentSummary && i.contentSummary.typeName) || i.itemClass || '';
        return t === 'supplement';
    }).slice(0, maxItems);

    const results = await Promise.all(supplements.map(async (item) => {
        try {
            const r = await fetch(
                `https://www.coursera.org/api/onDemandSupplements.v1/${item.id}?includes=asset&fields=onDemandSupplements.v1(name,typedAsset)`,
                { headers: capturedAuthToken ? { "X-CSRF3-Token": capturedAuthToken } : {} }
            );
            const d = await r.json();
            if (d.elements && d.elements[0]) {
                const el = d.elements[0];
                const html = el.typedAsset && el.typedAsset.definition && el.typedAsset.definition.value || '';
                const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (text) return { name: el.name || item.id, text: text.slice(0, maxChars) };
            }
        } catch (e) {}
        return null;
    }));
    return results.filter(Boolean);
}

async function handleFillPeerReview(sendResponse) {
    const isPeerPage = window.location.href.includes("/peer/") ||
        !!document.querySelector('[data-testid*="peer"]') ||
        [...document.querySelectorAll("h1,h2")].some(h => h.innerText.includes("Peer") && h.innerText.includes("Review"));

    if (!isPeerPage) { sendResponse({ error: "Navigate to a peer review page first." }); return; }

    showOrUpdateBanner("Reading peer review content...", "info");

    const rubricEl = document.querySelector('[data-testid*="rubric"], .rc-RubricCriteria, [class*="rubric"]');
    const rubricText = rubricEl ? rubricEl.innerText.trim() : document.body.innerText.slice(0, 3000);
    const subEl = document.querySelector('[data-testid*="submission"], textarea[readonly], .submission-content');
    const submissionText = subEl ? subEl.innerText.trim() : "";

    chrome.runtime.sendMessage({ action: "generatePeerReview", rubric: rubricText, submission: submissionText }, (response) => {
        if (response && response.result) {
            const textAreas = document.querySelectorAll("textarea:not([readonly]), [contenteditable='true']");
            textAreas.forEach((ta, i) => {
                const review = response.result[i] || response.result[response.result.length - 1];
                if (!review) return;
                const text = review.review || "";
                if (ta.hasAttribute("contenteditable")) {
                    ta.focus();
                    setTimeout(() => { document.execCommand("selectAll", false, null); document.execCommand("insertText", false, text); }, 50);
                } else {
                    ta.value = text;
                    ta.dispatchEvent(new Event("input", { bubbles: true }));
                    ta.dispatchEvent(new Event("change", { bubbles: true }));
                }
            });
            showOrUpdateBanner("Peer review filled! ✅", "success");
            setTimeout(hideBanner, 4000);
            sendResponse({ ok: true });
        } else {
            showOrUpdateBanner("Failed to generate review.", "error");
            setTimeout(hideBanner, 4000);
            sendResponse({ error: (response && response.error) || "Failed." });
        }
    });
}

async function handleStartAutopilot(sendResponse) {
    if (!capturedCourseId) {
        const m = window.location.pathname.match(/\/learn\/([^/]+)/);
        if (m) capturedCourseId = m[1];
    }
    if (!capturedCourseId || !capturedAuthToken) {
        sendResponse({ error: "Missing course ID or auth token. Click around the course first." });
        return;
    }
    showOrUpdateBanner("Building autopilot queue... 🤖", "info");
    try {
        const url = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${capturedCourseId}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(lessonIds),onDemandCourseMaterialLessons.v1(itemIds),onDemandCourseMaterialItems.v2(name,itemClass,contentSummary)`;
        const res = await fetch(url, { headers: { "X-CSRF3-Token": capturedAuthToken } });
        const courseData = await res.json();
        const items = (courseData.linked && courseData.linked['onDemandCourseMaterialItems.v2']) || [];

        const queue = [];
        items.forEach(item => {
            const t = (item.contentSummary && item.contentSummary.typeName) || item.itemClass || 'unknown';
            if (t === 'lecture' || t === 'unknown') queue.push(`https://www.coursera.org/learn/${capturedCourseId}/lecture/${item.id}`);
            else if (t === 'supplement') queue.push(`https://www.coursera.org/learn/${capturedCourseId}/supplement/${item.id}`);
        });

        if (queue.length === 0) { sendResponse({ error: "No navigable items found." }); return; }

        await chrome.storage.local.set({ autopilotActive: true, autopilotQueue: queue, autopilotIndex: 0 });
        showOrUpdateBanner(`Autopilot active — ${queue.length} items 🤖`, "info");
        injectStopAutopilotButton();
        sendResponse({ status: "started" });
        setTimeout(() => { window.location.href = queue[0]; }, 1000);
    } catch (e) {
        sendResponse({ error: "Failed to build queue: " + e.message });
    }
}

function injectStopAutopilotButton() {
    if (document.getElementById("autopilot-stop-btn")) return;
    const btn = document.createElement("button");
    btn.id = "autopilot-stop-btn";
    btn.innerText = "Stop Autopilot";
    btn.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999998;background:#ef4444;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:bold;cursor:pointer;font-size:14px;font-family:inherit;";
    btn.addEventListener("click", () => { chrome.storage.local.set({ autopilotActive: false }); btn.remove(); hideBanner(); });
    document.body.appendChild(btn);
}

chrome.storage.local.get(["autopilotActive"], (s) => {
    if (s.autopilotActive) { showOrUpdateBanner("Autopilot active 🤖", "info"); injectStopAutopilotButton(); }
});

async function handleCompleteSpecialization() {
    if (!capturedCourseId) {
        const m = window.location.pathname.match(/\/learn\/([^/]+)/);
        if (m) capturedCourseId = m[1];
    }
    if (!capturedCourseId || !capturedAuthToken) {
        showOrUpdateBanner("Missing course ID or auth token.", "error");
        setTimeout(hideBanner, 4000);
        return;
    }
    showOrUpdateBanner("Detecting specialization...", "info");
    try {
        const courseRes = await fetch(
            `https://www.coursera.org/api/onDemandCourses.v1?q=slug&slug=${capturedCourseId}&fields=specializations`,
            { headers: { "X-CSRF3-Token": capturedAuthToken } }
        );
        const courseData = await courseRes.json();
        const courseEl = courseData.elements && courseData.elements[0];
        let courseIds = [];

        if (courseEl && courseEl.specializations && courseEl.specializations.length > 0) {
            const specId = courseEl.specializations[0];
            const specRes = await fetch(`https://www.coursera.org/api/onDemandSpecializations.v1/${specId}?includes=courseIds`, { headers: { "X-CSRF3-Token": capturedAuthToken } });
            const specData = await specRes.json();
            const specEl = specData.elements && specData.elements[0];
            if (specEl && specEl.courseIds) courseIds = specEl.courseIds;
        }

        if (courseIds.length === 0) {
            showOrUpdateBanner("No specialization found — completing current course.", "info");
            await startCompletionLoop(null);
            return;
        }

        for (let i = 0; i < courseIds.length; i++) {
            showOrUpdateBanner(`Specialization: completing course ${i + 1} of ${courseIds.length}... ⚡`, "info");
            try { await completeCourseById(courseIds[i]); } catch (_) {}
            await new Promise(r => setTimeout(r, 500));
        }
        showOrUpdateBanner("Specialization completed! 🎓", "success");
        setTimeout(hideBanner, 6000);
    } catch (e) {
        showOrUpdateBanner("Error: " + e.message, "error");
        setTimeout(hideBanner, 5000);
    }
}

async function completeCourseById(internalCourseId) {
    const res = await fetch(
        `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=courseId&courseId=${internalCourseId}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(lessonIds),onDemandCourseMaterialLessons.v1(itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary)`,
        { headers: { "X-CSRF3-Token": capturedAuthToken } }
    );
    const courseData = await res.json();
    const itemsToComplete = extractVideoAndReadingIds(courseData);
    if (itemsToComplete.length === 0) return;

    const finalUserId = capturedUserId || "~";
    const CHUNK_SIZE = 6;
    for (let i = 0; i < itemsToComplete.length; i += CHUNK_SIZE) {
        const chunk = itemsToComplete.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (itemObj) => {
            try {
                if (itemObj.type === 'lecture' || itemObj.type === 'unknown') {
                    return fetch(`https://www.coursera.org/api/opencourse.v1/user/${finalUserId}/course/${internalCourseId}/item/${itemObj.id}/lecture/videoEvents/ended?autoEnroll=false`, {
                        method: "POST", headers: { "Content-Type": "application/json", "X-CSRF3-Token": capturedAuthToken }, body: JSON.stringify({ contentRequestBody: {} })
                    });
                } else if (itemObj.type === 'supplement') {
                    return fetch(`https://www.coursera.org/api/onDemandSupplementCompletions.v1`, {
                        method: "POST", headers: { "Content-Type": "application/json", "X-CSRF3-Token": capturedAuthToken },
                        body: JSON.stringify({ userId: parseInt(finalUserId) || finalUserId, courseId: internalCourseId, itemId: itemObj.id })
                    });
                }
            } catch (e) {}
        }));
        await new Promise(r => setTimeout(r, 400));
    }
}

async function handleOpenTranscriptQA() {
    showOrUpdateBanner("Fetching video transcript...", "info");
    const urlMatch = window.location.pathname.match(/\/(?:lecture|supplement|quiz|exam)\/([^/?]+)/);
    const itemId = urlMatch ? urlMatch[1] : null;

    if (itemId && capturedCourseId) {
        try {
            const res = await fetch(
                `https://www.coursera.org/api/onDemandLectureTranscripts.v1/${capturedCourseId}~${itemId}?includes=transcript&fields=onDemandLectureTranscripts.v1(transcript)`,
                { headers: capturedAuthToken ? { "X-CSRF3-Token": capturedAuthToken } : {} }
            );
            const data = await res.json();
            if (data.elements && data.elements[0] && data.elements[0].transcript) {
                const segments = data.elements[0].transcript;
                currentTranscript = Object.values(segments).map(s => s.text || "").join(" ");
            }
        } catch (e) {}
    }
    if (!currentTranscript) {
        const el = document.querySelector('.rc-MarkdownViewer, [data-testid="cml-viewer"]');
        if (el) currentTranscript = el.innerText.slice(0, 6000);
    }
    hideBanner();
    injectTranscriptQAPanel();
}

function injectTranscriptQAPanel() {
    if (document.getElementById("coursera-qa-panel")) return;
    const panel = document.createElement("div");
    panel.id = "coursera-qa-panel";
    panel.style.cssText = "position:fixed;bottom:90px;right:20px;z-index:9999998;width:320px;height:400px;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.18);display:flex;flex-direction:column;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;border:1px solid #e2e8f0;";
    panel.innerHTML = `
        <div style="padding:12px 16px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#2563eb;border-radius:12px 12px 0 0;">
            <span style="color:#fff;font-weight:700;font-size:14px;">Ask About This Video</span>
            <button id="qa-close" style="background:transparent;border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;padding:0;">×</button>
        </div>
        <div id="qa-history" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;">
            <div style="background:#f1f5f9;border-radius:8px;padding:8px 12px;font-size:12px;color:#475569;align-self:flex-start;max-width:85%;">${currentTranscript ? "Transcript loaded! Ask anything about this video." : "No transcript found — you can still ask general questions."}</div>
        </div>
        <div style="padding:8px;border-top:1px solid #e2e8f0;display:flex;gap:6px;">
            <input id="qa-input" type="text" placeholder="Ask a question..." style="flex:1;height:34px;border:1px solid #e2e8f0;border-radius:8px;padding:0 10px;font-size:12px;outline:none;">
            <button id="qa-send" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:0 12px;cursor:pointer;font-weight:600;font-size:12px;">Send</button>
        </div>`;
    document.body.appendChild(panel);
    document.getElementById("qa-close").addEventListener("click", () => panel.remove());

    function sendQA() {
        const input = document.getElementById("qa-input");
        const q = input.value.trim();
        if (!q) return;
        input.value = "";
        const hist = document.getElementById("qa-history");
        const uBubble = document.createElement("div");
        uBubble.style.cssText = "background:#2563eb;color:#fff;border-radius:8px;padding:8px 12px;font-size:12px;align-self:flex-end;max-width:85%;";
        uBubble.innerText = q;
        hist.appendChild(uBubble);
        const loadBubble = document.createElement("div");
        loadBubble.style.cssText = "background:#f1f5f9;color:#475569;border-radius:8px;padding:8px 12px;font-size:12px;align-self:flex-start;max-width:85%;";
        loadBubble.innerText = "Thinking...";
        hist.appendChild(loadBubble);
        hist.scrollTop = hist.scrollHeight;
        chrome.runtime.sendMessage({ action: "transcriptQA", question: q, transcript: currentTranscript || "" }, (r) => {
            loadBubble.innerText = (r && r.answer) ? r.answer : "Sorry, couldn't get an answer.";
            hist.scrollTop = hist.scrollHeight;
        });
    }
    document.getElementById("qa-send").addEventListener("click", sendQA);
    document.getElementById("qa-input").addEventListener("keydown", e => { if (e.key === "Enter") sendQA(); });
}

async function handleWriteForumPost(sendResponse) {
    showOrUpdateBanner("Analyzing discussion topic...", "info");
    if (!capturedCourseId) {
        const m = window.location.pathname.match(/\/learn\/([^/]+)/);
        if (m) capturedCourseId = m[1];
    }
    const topicEl = document.querySelector('[data-testid*="prompt"], .discussion-prompt, h1, h2');
    const topicText = topicEl ? topicEl.innerText.trim() : document.title;

    chrome.runtime.sendMessage({ action: "generateForumPost", topic: topicText, courseId: capturedCourseId }, (response) => {
        if (response && response.post) {
            const editor = document.querySelector('textarea:not([readonly]), [data-slate-editor="true"], [contenteditable="true"]');
            if (editor) {
                if (editor.hasAttribute("contenteditable") || editor.getAttribute("data-slate-editor") === "true") {
                    editor.focus();
                    setTimeout(() => { document.execCommand("selectAll", false, null); document.execCommand("insertText", false, response.post); }, 50);
                } else {
                    editor.value = response.post;
                    editor.dispatchEvent(new Event("input", { bubbles: true }));
                    editor.dispatchEvent(new Event("change", { bubbles: true }));
                }
                showOrUpdateBanner("Forum post written! ✅", "success");
                setTimeout(hideBanner, 4000);
                sendResponse({ ok: true });
            } else {
                showOrUpdateBanner("No text editor found on this page.", "error");
                setTimeout(hideBanner, 4000);
                sendResponse({ error: "No text editor found." });
            }
        } else {
            showOrUpdateBanner("Failed to generate post.", "error");
            setTimeout(hideBanner, 4000);
            sendResponse({ error: (response && response.error) || "Failed." });
        }
    });
}

async function handleAnalyzeSpeedRun(sendResponse) {
    if (!capturedCourseId) {
        const m = window.location.pathname.match(/\/learn\/([^/]+)/);
        if (m) capturedCourseId = m[1];
    }
    if (!capturedCourseId) { sendResponse({ error: "Could not detect course ID." }); return; }
    try {
        const res = await fetch(
            `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${capturedCourseId}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(lessonIds),onDemandCourseMaterialLessons.v1(itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary)`,
            { headers: capturedAuthToken ? { "X-CSRF3-Token": capturedAuthToken } : {} }
        );
        const courseData = await res.json();
        const items = (courseData.linked && courseData.linked['onDemandCourseMaterialItems.v2']) || [];
        let total = items.length, required = 0, skippable = 0, finalExam = null, lockedCount = 0;
        items.forEach(item => {
            const t = (item.contentSummary && item.contentSummary.typeName) || item.itemClass || '';
            const name = item.name || '';
            if (item.isLocked) lockedCount++;
            const isQuiz = ['quiz','exam','programming','phasedPeer','peer','ungradedAssignment','staffGraded'].includes(t);
            if (isQuiz || name.toLowerCase().includes('quiz') || name.toLowerCase().includes('exam')) {
                required++;
                if (t === 'exam' || name.toLowerCase().includes('final')) finalExam = name;
            } else { skippable++; }
        });
        if (!finalExam) {
            for (let i = items.length - 1; i >= 0; i--) {
                const t = (items[i].contentSummary && items[i].contentSummary.typeName) || items[i].itemClass || '';
                if (['quiz','exam'].includes(t)) { finalExam = items[i].name; break; }
            }
        }
        sendResponse({ total, required, skippable, finalExam: finalExam || "Not found", locked: lockedCount });
    } catch (e) { sendResponse({ error: "Failed to analyze: " + e.message }); }
}

async function handleSolveCodingAssignment(sendResponse) {
    showOrUpdateBanner("Analyzing coding assignment...", "info");
    const instrEl = document.querySelector('[data-testid*="instruction"], .rc-MarkdownViewer, .assignment-instructions, .notebook-instructions');
    const instructions = instrEl ? instrEl.innerText.trim() : (document.querySelector("main") || document.body).innerText.slice(0, 4000);

    if (!instructions) { sendResponse({ error: "Could not find assignment instructions." }); hideBanner(); return; }

    const langs = ["python","java","javascript","c++","r","sql","scala","go","rust","swift"];
    const pageText = document.body.innerText.toLowerCase();
    const detectedLang = langs.find(l => pageText.includes(l)) || "detect from context";

    chrome.runtime.sendMessage({ action: "generateCode", instructions, language: detectedLang }, (response) => {
        hideBanner();
        if (response && response.code) {
            injectCodePanel(response.code, detectedLang);
            sendResponse({ ok: true });
        } else {
            sendResponse({ error: (response && response.error) || "Failed to generate code." });
        }
    });
}

function injectCodePanel(code, language) {
    const existing = document.getElementById("coursera-code-panel");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "coursera-code-panel";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;";
    const card = document.createElement("div");
    card.style.cssText = "background:#fff;border-radius:12px;width:80%;max-width:800px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,0.4);font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;";
    card.innerHTML = `
        <div style="padding:16px 20px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:700;font-size:16px;color:#0f172a;">Code Solution${language && language !== 'detect from context' ? ' (' + language + ')' : ''}</span>
            <div style="display:flex;gap:8px;">
                <button id="code-copy-btn" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:6px 14px;cursor:pointer;font-weight:600;font-size:13px;">Copy</button>
                <button id="code-close-btn" style="background:#e2e8f0;color:#475569;border:none;border-radius:8px;padding:6px 14px;cursor:pointer;font-weight:600;font-size:13px;">Close</button>
            </div>
        </div>
        <pre style="flex:1;overflow:auto;padding:20px;margin:0;background:#0f172a;color:#e2e8f0;border-radius:0 0 12px 12px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-wrap:break-word;"><code id="code-content"></code></pre>`;
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.getElementById("code-content").textContent = code;
    document.getElementById("code-close-btn").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    document.getElementById("code-copy-btn").addEventListener("click", () => {
        navigator.clipboard.writeText(code).then(() => {
            const btn = document.getElementById("code-copy-btn");
            btn.innerText = "Copied!"; btn.style.background = "#16a34a";
            setTimeout(() => { btn.innerText = "Copy"; btn.style.background = "#2563eb"; }, 2000);
        });
    });
}

function initFloatingTutor() {
    if (document.getElementById("coursera-tutor-btn")) return;

    const tutorBtn = document.createElement("button");
    tutorBtn.id = "coursera-tutor-btn";
    tutorBtn.title = "AI Tutor";
    tutorBtn.innerHTML = "🎓";
    tutorBtn.style.cssText = "position:fixed;bottom:24px;right:24px;z-index:9999997;width:52px;height:52px;border-radius:50%;background:#2563eb;color:#fff;border:none;font-size:22px;cursor:pointer;box-shadow:0 4px 16px rgba(37,99,235,0.4);transition:transform 0.15s ease;display:flex;align-items:center;justify-content:center;";
    tutorBtn.addEventListener("mouseenter", () => { tutorBtn.style.transform = "scale(1.1)"; });
    tutorBtn.addEventListener("mouseleave", () => { tutorBtn.style.transform = "scale(1)"; });
    document.body.appendChild(tutorBtn);

    const panel = document.createElement("div");
    panel.id = "coursera-tutor-panel";
    panel.style.cssText = "position:fixed;bottom:88px;right:24px;z-index:9999997;width:340px;height:480px;background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.18);display:none;flex-direction:column;font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;border:1px solid #e2e8f0;";
    panel.innerHTML = `
        <div style="padding:14px 16px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;background:#2563eb;border-radius:12px 12px 0 0;">
            <span style="color:#fff;font-weight:700;font-size:15px;">🎓 AI Tutor</span>
            <button id="tutor-close" style="background:transparent;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0;line-height:1;">×</button>
        </div>
        <div id="tutor-history" style="flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;">
            <div style="background:#f1f5f9;border-radius:8px;padding:8px 12px;font-size:13px;color:#475569;align-self:flex-start;max-width:85%;">Hi! I'm your AI tutor. Ask me anything about this content.</div>
        </div>
        <div style="padding:8px;border-top:1px solid #e2e8f0;display:flex;gap:6px;">
            <input id="tutor-input" type="text" placeholder="Ask a question..." style="flex:1;height:36px;border:1px solid #e2e8f0;border-radius:8px;padding:0 10px;font-size:13px;outline:none;">
            <button id="tutor-send" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:0 14px;cursor:pointer;font-weight:600;font-size:13px;">Send</button>
        </div>`;
    document.body.appendChild(panel);

    let panelOpen = false;
    tutorBtn.addEventListener("click", () => {
        panelOpen = !panelOpen;
        panel.style.display = panelOpen ? "flex" : "none";
        if (panelOpen && !tutorContext) fetchTutorContext();
    });
    document.getElementById("tutor-close").addEventListener("click", () => { panelOpen = false; panel.style.display = "none"; });

    function addTutorBubble(text, role) {
        const hist = document.getElementById("tutor-history");
        const bubble = document.createElement("div");
        bubble.style.cssText = role === "user"
            ? "background:#2563eb;color:#fff;border-radius:8px;padding:8px 12px;font-size:13px;align-self:flex-end;max-width:85%;word-wrap:break-word;"
            : "background:#f1f5f9;color:#475569;border-radius:8px;padding:8px 12px;font-size:13px;align-self:flex-start;max-width:85%;word-wrap:break-word;";
        bubble.innerText = text;
        hist.appendChild(bubble);
        hist.scrollTop = hist.scrollHeight;
        return bubble;
    }

    function sendTutorMsg() {
        const input = document.getElementById("tutor-input");
        const msg = input.value.trim();
        if (!msg) return;
        input.value = "";
        chatHistory.push({ role: "user", text: msg });
        addTutorBubble(msg, "user");
        const loadBubble = addTutorBubble("Thinking...", "ai");
        chrome.runtime.sendMessage({ action: "tutorChat", message: msg, context: tutorContext || "", history: chatHistory.slice(-10) }, (r) => {
            const reply = (r && r.reply) ? r.reply : "Sorry, couldn't get a response.";
            loadBubble.innerText = reply;
            chatHistory.push({ role: "model", text: reply });
            document.getElementById("tutor-history").scrollTop = 99999;
        });
    }

    document.getElementById("tutor-send").addEventListener("click", sendTutorMsg);
    document.getElementById("tutor-input").addEventListener("keydown", e => { if (e.key === "Enter") sendTutorMsg(); });
}

async function fetchTutorContext() {
    const urlMatch = window.location.pathname.match(/\/(?:lecture|supplement)\/([^/?]+)/);
    const itemId = urlMatch ? urlMatch[1] : null;

    const contentEl = document.querySelector('.rc-MarkdownViewer, [data-testid="cml-viewer"]');
    if (contentEl) { tutorContext = contentEl.innerText.slice(0, 4000); return; }

    if (itemId && capturedCourseId && window.location.pathname.includes("/lecture/")) {
        try {
            const res = await fetch(
                `https://www.coursera.org/api/onDemandLectureTranscripts.v1/${capturedCourseId}~${itemId}?includes=transcript&fields=onDemandLectureTranscripts.v1(transcript)`,
                { headers: capturedAuthToken ? { "X-CSRF3-Token": capturedAuthToken } : {} }
            );
            const data = await res.json();
            if (data.elements && data.elements[0] && data.elements[0].transcript) {
                tutorContext = Object.values(data.elements[0].transcript).map(s => s.text || "").join(" ").slice(0, 4000);
            }
        } catch (e) {}
    }
}

if (document.readyState === "complete") {
    setTimeout(initFloatingTutor, 2000);
} else {
    window.addEventListener("load", () => setTimeout(initFloatingTutor, 2000));
}

(async () => {
    await new Promise(r => {
        if (document.readyState === "complete") r();
        else window.addEventListener("load", r);
    });

    const s = await new Promise(r => chrome.storage.local.get(['walkAwayActive', 'walkAwayCourses', 'walkAwayIndex'], r));
    if (!s.walkAwayActive) return;

    const courses = s.walkAwayCourses || [];
    const index = s.walkAwayIndex || 0;
    if (index >= courses.length) {
        await chrome.storage.local.set({ walkAwayActive: false });
        return;
    }

    const currentCourse = courses[index];
    const urlMatch = window.location.pathname.match(/\/learn\/([^/]+)/);
    if (!urlMatch || urlMatch[1] !== currentCourse.id) return;

    showOrUpdateBanner(`Walk-Away: Course ${index + 1} of ${courses.length} — ${currentCourse.name}`, "info");
    const stopBtn = document.createElement("button");
    stopBtn.id = "walk-away-stop-btn";
    stopBtn.innerText = "Stop Walk-Away";
    stopBtn.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999998;background:#ef4444;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:bold;cursor:pointer;font-size:14px;font-family:inherit;";
    stopBtn.addEventListener("click", () => { chrome.storage.local.set({ walkAwayActive: false }); stopBtn.remove(); hideBanner(); });
    document.body.appendChild(stopBtn);

    // Wait for auth tokens (Coursera injects them via XHR interception)
    let waited = 0;
    while (!capturedAuthToken && waited < 12000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
    }

    if (!capturedAuthToken) {
        // Try fallback: set course ID from URL and proceed without token check
        capturedCourseId = currentCourse.id;
        showOrUpdateBanner("Walk-Away: Could not capture auth token. Refresh this page to retry.", "error");
        setTimeout(hideBanner, 8000);
        return;
    }

    capturedCourseId = currentCourse.id;
    await startCompletionLoop(null);
})();

async function startFullCourse() {
    showOrUpdateBanner("Loading course map...", "info");

    try {
        const url = `https://www.coursera.org/api/onDemandCourseMaterials.v2/?q=slug&slug=${capturedCourseId}&includes=modules,lessons,items&fields=moduleIds,onDemandCourseMaterialModules.v1(name,lessonIds),onDemandCourseMaterialLessons.v1(itemIds),onDemandCourseMaterialItems.v2(name,isLocked,itemClass,contentSummary)`;
        const res = await fetch(url, { headers: { "X-CSRF3-Token": capturedAuthToken, "Referer": `https://www.coursera.org/learn/${capturedCourseId}` } });
        const courseData = await res.json();
        const allItems = (courseData.linked && courseData.linked['onDemandCourseMaterialItems.v2']) || [];

        // Item types that require navigation — cannot be completed via the materials API
        const needsNavigationTypes = ['quiz', 'exam', 'phasedPeer', 'peer', 'ungradedAssignment', 'programming', 'gradedLab'];
        const quizItems = allItems.filter(item => {
            if (item.isLocked) return false;
            const t = (item.contentSummary && item.contentSummary.typeName) || item.itemClass || '';
            return needsNavigationTypes.includes(t);
        });

        await startCompletionLoop(null, { skipSignal: true });

        if (quizItems.length === 0) {
            showOrUpdateBanner("All done! No interactive assignments found.", "success");
            setTimeout(hideBanner, 6000);
            return;
        }

        const quizQueue = quizItems.map(item => {
            const t = (item.contentSummary && item.contentSummary.typeName) || item.itemClass || '';
            const base = `https://www.coursera.org/learn/${capturedCourseId}`;
            if (t === 'phasedPeer' || t === 'peer') return `${base}/peer/${item.id}`;
            if (t === 'programming') return `${base}/programming/${item.id}`;
            if (t === 'gradedLab' || t === 'ungradedLab') return `${base}/ungradedLab/${item.id}`;
            return `${base}/quiz/${item.id}`;
        });

        await chrome.storage.local.set({ quizPilotActive: true, quizPilotQueue: quizQueue, quizPilotIndex: 0 });
        showOrUpdateBanner(`Videos done! Starting quiz solver — ${quizItems.length} quizzes queued...`, "info");
        setTimeout(() => { window.location.href = quizQueue[0]; }, 3000);

    } catch (e) {
        showOrUpdateBanner("Error: " + e.message, "error");
        setTimeout(hideBanner, 5000);
    }
}

function injectCodeIntoEditor(code) {
    // CodeMirror 5
    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl && cmEl.CodeMirror) {
        cmEl.CodeMirror.setValue(code);
        cmEl.CodeMirror.focus();
        return true;
    }
    // Monaco
    if (window.monaco && window.monaco.editor) {
        const editors = window.monaco.editor.getEditors();
        if (editors && editors.length > 0) {
            editors[0].setValue(code);
            editors[0].focus();
            return true;
        }
    }
    // Ace Editor
    const aceEl = document.querySelector('.ace_editor');
    if (aceEl && window.ace) {
        try {
            const aceInst = window.ace.edit(aceEl);
            aceInst.setValue(code, -1);
            aceInst.focus();
            return true;
        } catch (_) {}
    }
    // contenteditable
    const contentEditable = document.querySelector('[contenteditable="true"]');
    if (contentEditable) {
        contentEditable.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, code);
        return true;
    }
    // textarea fallback
    const ta = document.querySelector('textarea');
    if (ta) {
        const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSet.call(ta, code);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }
    return false;
}

async function handleProgrammingPage() {
    showOrUpdateBanner("Extracting programming assignment instructions...", "info");
    await new Promise(r => setTimeout(r, 3000));

    const instructionSelectors = [
        '.rc-InstructionWrapper', '.programming-assignment-content',
        '[data-testid="assignment-instructions"]', '.rc-ProgrammingAssignment',
        'main', '.rc-ContentContainer'
    ];
    let instructionText = '';
    for (const sel of instructionSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 40) {
            instructionText = el.innerText.trim().slice(0, 4000);
            break;
        }
    }
    if (!instructionText) {
        instructionText = document.body.innerText.slice(0, 4000);
    }

    let language = 'python';
    const pageText = document.body.innerText.toLowerCase();
    if (pageText.includes('javascript') || pageText.includes('node.js')) language = 'javascript';
    else if (pageText.includes('java') && !pageText.includes('javascript')) language = 'java';
    else if (pageText.includes('c++') || pageText.includes('cpp')) language = 'cpp';
    else if (pageText.includes('r language') || pageText.includes('r programming')) language = 'r';
    else if (pageText.includes('sql')) language = 'sql';

    showOrUpdateBanner(`Generating ${language} solution...`, "info");

    return new Promise((resolve) => {
        chrome.runtime.sendMessage({
            action: "generateCode",
            instructions: instructionText,
            language
        }, (resp) => {
            if (!resp || !resp.code) {
                showOrUpdateBanner("AI code generation failed — skipping.", "error");
                setTimeout(resolve, 2000);
                return;
            }
            const injected = injectCodeIntoEditor(resp.code);
            if (injected) {
                showOrUpdateBanner("Code injected — submitting...", "info");
                setTimeout(() => {
                    const submitBtn = [...document.querySelectorAll('button')].find(b => {
                        const t = b.innerText.trim().toLowerCase();
                        return ['submit', 'run', 'run code', 'submit code', 'grade'].some(k => t.includes(k));
                    });
                    if (submitBtn && !submitBtn.disabled) submitBtn.click();
                    setTimeout(resolve, 4000);
                }, 2000);
            } else {
                showOrUpdateBanner("Could not find code editor — skipping.", "error");
                setTimeout(resolve, 2000);
            }
        });
    });
}

function extractVideoAndReadingIds(jsonMap) {
    let ids = [];

    if (jsonMap && jsonMap.linked && jsonMap.linked['onDemandCourseMaterialItems.v2']) {
        const items = jsonMap.linked['onDemandCourseMaterialItems.v2'];
        items.forEach(item => {
            const exactType = (item.contentSummary && item.contentSummary.typeName) ? item.contentSummary.typeName : (item.itemClass || 'unknown');

            const isHardGraded = ['quiz', 'exam', 'programming', 'phasedPeer', 'peer', 'staffGraded', 'gradedLab'].includes(exactType);

            if (item && item.id && !isHardGraded && !item.isLocked) {
                ids.push({ id: item.id, type: exactType });
            }
        });
        return ids;
    }

    if (jsonMap && jsonMap.elements && jsonMap.elements[0] && jsonMap.elements[0].modules) {
        jsonMap.elements[0].modules.forEach(module => {
            if (module.lessons) {
                module.lessons.forEach(lesson => {
                    if (lesson.itemIds) {
                        lesson.itemIds.forEach(itemId => ids.push({ id: itemId, type: 'unknown' }));
                    }
                });
            }
        });
    }

    return ids;
}

(async () => {
    const s = await new Promise(r => chrome.storage.local.get(['quizPilotActive', 'quizPilotQueue', 'quizPilotIndex'], r));
    if (!s.quizPilotActive) return;

    const queue = s.quizPilotQueue || [];
    const idx = s.quizPilotIndex || 0;
    if (idx >= queue.length) {
        chrome.storage.local.set({ quizPilotActive: false });
        return;
    }

    const expectedId = queue[idx].split('/').pop();
    if (!window.location.pathname.includes(expectedId)) return;

    const stopBtn = document.createElement("button");
    stopBtn.id = "quiz-pilot-stop-btn";
    stopBtn.innerText = "Stop Quiz Solver";
    stopBtn.style.cssText = "position:fixed;top:16px;right:16px;z-index:9999998;background:#ef4444;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:bold;cursor:pointer;font-size:14px;font-family:inherit;";
    stopBtn.addEventListener("click", () => { chrome.storage.local.set({ quizPilotActive: false }); stopBtn.remove(); hideBanner(); });
    document.body.appendChild(stopBtn);

    showOrUpdateBanner(`Quiz solver: ${idx + 1} of ${queue.length}...`, "info");

    await new Promise(r => setTimeout(r, 4000));

    const startBtn = [...document.querySelectorAll('button')].find(b => {
        const t = b.innerText.trim().toLowerCase();
        return ['start', 'begin', 'begin quiz', 'start quiz', 'attempt quiz', 'open quiz'].includes(t);
    });
    if (startBtn && !startBtn.disabled) {
        startBtn.click();
        await new Promise(r => setTimeout(r, 3000));
    }

    const isProgramming = window.location.pathname.includes('/programming/');
    const isLab = window.location.pathname.includes('/ungradedLab/') || window.location.pathname.includes('/gradedLab/');

    if (isProgramming || isLab) {
        await handleProgrammingPage();
        const b = document.getElementById("quiz-pilot-stop-btn");
        if (b) b.remove();
        chrome.runtime.sendMessage({ action: "quizPilotItemDone" });
        return;
    }

    const questions = scrapeAssessment();
    if (!questions || questions.length === 0) {
        showOrUpdateBanner(`No questions found on item ${idx + 1} — skipping...`, "info");
        await new Promise(r => setTimeout(r, 2000));
        chrome.runtime.sendMessage({ action: "quizPilotItemDone" });
        return;
    }

    showOrUpdateBanner(`Solving ${questions.length} questions...`, "info");

    const settings = await new Promise(r => chrome.storage.local.get(['customInstructions', 'toggleHumanStyle'], r));

    chrome.runtime.sendMessage({
        action: "fetchAIExplanation",
        text: questions,
        withExplanations: false,
        humanStyle: !!settings.toggleHumanStyle,
        customInstructions: settings.customInstructions || ""
    }, (aiResponse) => {
        if (aiResponse && aiResponse.result) {
            applyAnswersToDOM(aiResponse.result, !!settings.toggleHumanStyle);
            showOrUpdateBanner("Answers applied — submitting...", "info");
            setTimeout(() => {
                attemptAutoSubmit();
                setTimeout(() => {
                    const b = document.getElementById("quiz-pilot-stop-btn");
                    if (b) b.remove();
                    chrome.runtime.sendMessage({ action: "quizPilotItemDone" });
                }, 4000);
            }, 1500);
        } else {
            showOrUpdateBanner(`AI error on item ${idx + 1} — skipping...`, "error");
            setTimeout(() => {
                const b = document.getElementById("quiz-pilot-stop-btn");
                if (b) b.remove();
                chrome.runtime.sendMessage({ action: "quizPilotItemDone" });
            }, 3000);
        }
    });
})();
