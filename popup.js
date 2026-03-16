chrome.storage.local.get(["userApiKey"], (result) => {
  if (result.userApiKey) {
    document.getElementById("apiKeyInput").value = result.userApiKey;
  }
});
document.getElementById("saveBtn").addEventListener("click", () => {
  const key = document.getElementById("apiKeyInput").value.trim();
  chrome.storage.local.set({ userApiKey: key }, () => {
    const status = document.getElementById("status");
    status.innerText = "Key saved successfully!";
    setTimeout(() => (status.innerText = ""), 2000);
  });
});
document.getElementById("explainBtn").addEventListener("click", async () => {
  const explainBtn = document.getElementById("explainBtn");
  const resultDiv = document.getElementById("result");

  // Helper to reset button state
  const resetButton = () => {
    explainBtn.disabled = false;
    explainBtn.innerHTML = "Answer the questions !";
    explainBtn.style.opacity = "1";
    explainBtn.style.cursor = "pointer";
  };

  // Helper to show styled results
  const showResult = (text, type = "default") => {
    resultDiv.style.display = "block";
    resultDiv.innerText = text;
    
    // Apply styling based on success/error
    if (type === "error") {
      resultDiv.style.color = "#ef4444"; // destructive red
      resultDiv.style.borderColor = "#f87171";
      resultDiv.style.backgroundColor = "#fef2f2";
    } else if (type === "success") {
      resultDiv.style.color = "#16a34a"; // success green
      resultDiv.style.borderColor = "#4ade80";
      resultDiv.style.backgroundColor = "#f0fdf4";
    } else {
      resultDiv.style.color = "var(--foreground)";
      resultDiv.style.borderColor = "var(--border)";
      resultDiv.style.backgroundColor = "var(--background)";
    }
  };

  // --- START LOADING STATE ---
  explainBtn.disabled = true;
  explainBtn.innerHTML = `<span class="spinner"></span> Reading page...`;
  explainBtn.style.opacity = "0.7";
  explainBtn.style.cursor = "not-allowed";
  resultDiv.style.display = "none"; // Hide old results

  try {
    let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    chrome.tabs.sendMessage(tab.id, { action: "getSelection" }, (response) => {
      if (chrome.runtime.lastError) {
        showResult("Please refresh the page to use the extension.", "error");
        resetButton();
        return;
      }

      if (response && response.data && response.data.length > 0) {
        
        // Update loading text for the AI phase
        explainBtn.innerHTML = `<span class="spinner"></span> Thinking... 🤔`;

        chrome.runtime.sendMessage(
          { action: "fetchAIExplanation", text: response.data },
          (aiResponse) => {
            if (aiResponse.error) {
              showResult("Error: Could not connect to the AI.", "error");
            } else {
              chrome.tabs.sendMessage(tab.id, { action: "applyAIResponse", data: aiResponse.result });
              showResult("The answers have been applied! Scroll down to see them.", "success");
            }
            // --- END LOADING STATE ---
            resetButton();
          }
        );
      } else {
        showResult("Something went wrong while extracting the content.", "error");
        resetButton();
      }
    });
  } catch (error) {
    showResult("An unexpected error occurred.", "error");
    resetButton();
  }
});
document.getElementById("showQuestionsBtn").addEventListener("click", async () => {
  const resultDiv = document.getElementById("result");
  resultDiv.style.display = "block";
  resultDiv.innerText = "Extracting...";

  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { action: "getSelection" }, (response) => {
    if (chrome.runtime.lastError) {
      resultDiv.innerText = "Please refresh the page to use the extension.";
      return;
    }
    
    if (response && response.data && response.data.length > 0) {
      
      // IMPROVEMENT: Injecting a clean UI with a "Copy" button and pre-formatted text
      resultDiv.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid var(--border); padding-bottom: 8px;">
          <strong style="font-size: 12px; color: var(--foreground);">Extracted Content:</strong>
          <button id="copyContentBtn" class="btn btn-primary" style="height: 24px; padding: 0 10px; width: auto; font-size: 11px; margin: 0;">Copy</button>
        </div>
        <div style="white-space: pre-wrap; font-size: 12px; color: var(--muted-foreground); user-select: all;">${JSON.stringify(response.data, null, 2)}</div>
      `;

      // Add the clipboard functionality to the new button
      document.getElementById("copyContentBtn").addEventListener("click", (e) => {
        navigator.clipboard.writeText(JSON.stringify(response.data, null, 2)).then(() => {
          e.target.innerText = "Copied!";
          e.target.style.backgroundColor = "#16a34a"; // turn green on success
          
          setTimeout(() => {
            e.target.innerText = "Copy";
            e.target.style.backgroundColor = "var(--primary)"; // revert to normal
          }, 2000);
        });
      });

    } else {
      resultDiv.innerText = "Something went wrong while extracting the content.";
    }
  });
});