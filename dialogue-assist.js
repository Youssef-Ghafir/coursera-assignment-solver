// Page controls reuse the popup's dialogue and assessment actions.
(() => {
    const dismissedPaths = new Set();
    let panel = null;
    let refreshTimer = null;

    const prompts = {
        dialogue: {
            title: "Need help with this dialogue?",
            description: "Draft a reply with your selected AI provider, then review and send it.",
            action: "Fill Dialogue Answer",
            loading: "Drafting reply…"
        },
        assessment: {
            title: "Need help with this assignment?",
            description: "Fill supported quiz answers with your selected AI provider, then review before submitting.",
            action: "Solve Current Quiz",
            loading: "Solving questions…"
        }
    };

    const styles = `
        :host {
            all: initial;
            display: block;
            margin-block: 0 12px;
            container-type: inline-size;
            font-family: "Outfit", "Segoe UI", sans-serif;
            color-scheme: light dark;
            --surface: #f4f7ff;
            --border: #dbe3ee;
            --ink: #101b33;
            --muted: #42547c;
            --primary: #2f62ee;
            --hover: #2452d3;
            --success: #107348;
            --danger: #b82f41;
            --warning: #935800;
        }
        * { box-sizing: border-box; }
        .assist {
            position: relative;
            padding: 16px;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface);
            color: var(--ink);
            font-size: .875rem;
            line-height: 1.5;
        }
        .brand {
            display: flex;
            align-items: center;
            gap: 8px;
            margin: 0 40px 4px 0;
            color: var(--muted);
            font-size: .6875rem;
            font-weight: 700;
            letter-spacing: .09em;
            text-transform: uppercase;
        }
        .brand-icon { display: block; width: 24px; height: 24px; flex-shrink: 0; }
        h2 { margin: 0 40px 4px 0; font-size: 1rem; line-height: 1.4; }
        .description { margin: 0; max-width: 65ch; color: var(--muted); }
        .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin-top: 12px; }
        button { font: inherit; cursor: pointer; min-height: 44px; border: 0; border-radius: 8px; }
        button:focus-visible { outline: 3px solid var(--primary); outline-offset: 3px; }
        .fill { padding: 10px 16px; background: var(--primary); color: #fcfdff; font-weight: 650; }
        .fill:hover:not(:disabled) { background: var(--hover); }
        .fill:active:not(:disabled) { transform: translateY(1px); }
        .fill:disabled { opacity: .6; cursor: default; }
        .dismiss { position: absolute; inset-block-start: 8px; inset-inline-end: 8px; width: 44px; background: transparent; color: var(--muted); font-size: 1.375rem; }
        .dismiss:hover { background: var(--border); color: var(--ink); }
        .hint { margin: 0; color: var(--muted); font-size: .75rem; }
        .status { margin: 12px 0 0; overflow-wrap: anywhere; }
        .status:empty { display: none; }
        [data-state="success"] .status { color: var(--success); }
        [data-state="error"] .status { color: var(--danger); }
        [data-state="warning"] .status { color: var(--warning); }
        @container (max-width: 380px) {
            .actions { align-items: stretch; flex-direction: column; }
            .fill { width: 100%; }
        }
        @media (prefers-color-scheme: dark) {
            :host {
                --surface: #172238;
                --border: #2d3b54;
                --ink: #f2f6ff;
                --muted: #b4c3df;
                --primary: #2f62ee;
                --hover: #2452d3;
                --success: #69dda3;
                --danger: #ff9ba7;
                --warning: #ffc45c;
            }
        }
    `;

    function removePanel() {
        panel?.host.remove();
        panel = null;
    }

    function createPanel({ type, root, composer, anchor }) {
        const prompt = prompts[type];
        const host = document.createElement("div");
        host.id = `auto-coursera-${type}-assist`;
        const shadow = host.attachShadow({ mode: "open" });
        // Static markup only. AI output and errors are always assigned with textContent.
        shadow.innerHTML = `
            <style>${styles}</style>
            <section class="assist" aria-labelledby="assist-title" data-state="idle">
                <button class="dismiss" type="button" title="Dismiss for this activity">×</button>
                <p class="brand"><img class="brand-icon" width="24" height="24" alt=""><span>Coursera Auto Solver</span></p>
                <h2 id="assist-title"></h2>
                <p class="description"></p>
                <div class="actions">
                    <button class="fill" type="button" aria-describedby="assist-hint"></button>
                    <p id="assist-hint" class="hint">Uses the provider saved in the extension popup.</p>
                </div>
                <p class="status" role="status" aria-live="polite" aria-atomic="true"></p>
            </section>
        `;
        shadow.querySelector(".brand-icon").src = chrome.runtime.getURL("icons/icon48.png");
        shadow.querySelector("h2").textContent = prompt.title;
        shadow.querySelector(".description").textContent = prompt.description;
        shadow.querySelector(".fill").textContent = prompt.action;
        shadow.querySelector(".dismiss").setAttribute("aria-label", `Dismiss ${type} help for this activity`);

        const currentPanel = {
            host, root, composer, type, anchor,
            path: window.location.pathname,
            busy: false,
            section: shadow.querySelector("section"),
            button: shadow.querySelector(".fill"),
            hint: shadow.querySelector(".hint"),
            status: shadow.querySelector(".status")
        };

        shadow.querySelector(".dismiss").addEventListener("click", () => {
            dismissedPaths.add(currentPanel.path);
            if (panel === currentPanel) removePanel();
        });

        currentPanel.button.addEventListener("click", async () => {
            if (currentPanel.busy || currentPanel.button.disabled) return;
            currentPanel.busy = true;
            currentPanel.section.dataset.state = "loading";
            currentPanel.section.setAttribute("aria-busy", "true");
            currentPanel.button.disabled = true;
            currentPanel.button.textContent = prompt.loading;
            currentPanel.status.textContent = type === "dialogue"
                ? "Reading the conversation and asking your AI provider…"
                : "Reading the assessment questions…";

            try {
                if (type === "dialogue") {
                    await fillCurrentDialogueAnswer();
                    currentPanel.section.dataset.state = "success";
                    currentPanel.status.textContent = "Draft added. Review it in the message box before sending.";
                } else {
                    const result = await solveCurrentAssessment({
                        notify: false,
                        onProgress: (message) => { currentPanel.status.textContent = message; }
                    });
                    currentPanel.section.dataset.state = result.failures.length ? "warning" : "success";
                    const count = result.appliedCount;
                    const problems = [...new Set(result.failures.map((failure) => failure.questionNumber))].join(", ");
                    currentPanel.status.textContent = problems
                        ? `Filled ${count} answer${count === 1 ? "" : "s"}. Check question(s) ${problems}; they could not be fully processed. Review before submitting.`
                        : `Filled ${count} answer${count === 1 ? "" : "s"}. Review them before submitting.`;
                }
            } catch (error) {
                currentPanel.section.dataset.state = "error";
                currentPanel.status.textContent = error.message || "Could not generate answers. Check your AI provider in the extension popup and try again.";
            } finally {
                currentPanel.busy = false;
                currentPanel.section.setAttribute("aria-busy", "false");
                currentPanel.button.textContent = prompt.action;
                scheduleRefresh();
            }
        });

        // Keep prompts outside message history and assessment question blocks.
        anchor.before(host);
        panel = currentPanel;
    }

    function assessmentPromptAnchor(firstQuestion, questionBlocks) {
        // Coursera wraps each semantic question group in its own padded card.
        // Insert above that card, inside the shared question-list container.
        const questionCard = firstQuestion.closest('.css-1erl2aq, .css-12u8wr5');
        if (questionCard) return questionCard;

        // If card classes change, use the first branch of the shared container.
        let container = firstQuestion.parentElement;
        while (container && !questionBlocks.every((block) => container.contains(block))) {
            container = container.parentElement;
        }
        let anchor = firstQuestion;
        while (container && anchor.parentElement && anchor.parentElement !== container) {
            anchor = anchor.parentElement;
        }
        return anchor;
    }

    function detectActivity() {
        const root = document.querySelector('[data-testid="coursera-coach-item"], #coursera-coach-item');
        const composer = root && findDialogueComposer(root);
        const question = root?.querySelector('[data-testid="chat-message-llm"] [data-testid="coach-message-markdown"]');
        if (composer?.getClientRects().length && question?.textContent.trim()) {
            return {
                type: "dialogue", root, composer,
                anchor: composer.closest('[role="group"]') || composer.parentElement
            };
        }

        if (!/^\/learn\/[^/]+\/(assignment-submission|quiz|exam)\//.test(window.location.pathname)) return null;
        const questionBlocks = assessmentQuestionBlocks();
        const firstQuestion = questionBlocks.find((block) => (
            block.getClientRects().length &&
            !block.closest('[aria-hidden="true"], [aria-disabled="true"]') &&
            block.querySelector('[id^="prompt-"] [data-testid="cml-viewer"]')?.textContent.trim() &&
            block.querySelector('input:enabled:not([readonly]), textarea:enabled:not([readonly]), [contenteditable="true"], .monaco-editor[data-uri]')
        ));
        return firstQuestion ? {
            type: "assessment", root: firstQuestion, composer: null,
            anchor: assessmentPromptAnchor(firstQuestion, questionBlocks)
        } : null;
    }

    function refresh() {
        refreshTimer = null;
        const path = window.location.pathname;
        if (!path.startsWith("/learn/") || dismissedPaths.has(path)) {
            removePanel();
            return;
        }

        const activity = detectActivity();
        if (!activity) {
            // Keep ongoing feedback mounted while Coursera temporarily disables its input.
            if (panel?.busy && panel.path === path && panel.host.isConnected && panel.root.isConnected) return;
            removePanel();
            return;
        }

        if (panel && (panel.path !== path || panel.type !== activity.type || panel.root !== activity.root || panel.composer !== activity.composer || !panel.host.isConnected)) {
            removePanel();
        }
        if (!panel) createPanel(activity);
        if (panel.anchor !== activity.anchor || panel.host.nextElementSibling !== activity.anchor) {
            activity.anchor.before(panel.host);
            panel.anchor = activity.anchor;
        }

        const hasMessage = Boolean(activity.composer?.value.trim());
        panel.button.disabled = panel.busy || hasMessage;
        const hint = hasMessage
            ? "Your message is safe. Clear the box to draft another reply."
            : "Uses the provider saved in the extension popup.";
        if (panel.hint.textContent !== hint) panel.hint.textContent = hint;
    }

    function scheduleRefresh() {
        if (refreshTimer === null) refreshTimer = window.setTimeout(refresh, 150);
    }

    const observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["disabled", "readonly", "aria-disabled", "aria-hidden", "hidden"]
    });
    document.addEventListener("input", scheduleRefresh);
    window.addEventListener("popstate", scheduleRefresh);
    window.navigation?.addEventListener("navigatesuccess", scheduleRefresh);
    refresh();
})();
