/*! Alactic widget loader. Injects a chat bubble and an isolated iframe served by Alactic. */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var slug = script.getAttribute("data-agent");
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) {
    console.warn("[alactic] data-agent attribute is missing or invalid");
    return;
  }
  if (window.__alacticWidget) return;
  window.__alacticWidget = true;
  var origin = new URL(script.src).origin;
  var color = script.getAttribute("data-color") || "#111827";

  var frame = document.createElement("iframe");
  frame.src = origin + "/embed/" + slug;
  frame.title = "Support chat";
  frame.allow = "microphone; clipboard-write";
  frame.style.cssText =
    "position:fixed;bottom:88px;right:20px;width:380px;height:600px;max-width:calc(100vw - 40px);max-height:calc(100vh - 120px);" +
    "border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:2147483646;display:none;background:#fff;color-scheme:normal";

  var button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Open support chat");
  button.style.cssText =
    "position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;z-index:2147483647;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;background:" + color;
  var chatIcon =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var closeIcon =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  button.innerHTML = chatIcon;

  var open = false;
  button.addEventListener("click", function () {
    open = !open;
    frame.style.display = open ? "block" : "none";
    button.innerHTML = open ? closeIcon : chatIcon;
    button.setAttribute("aria-label", open ? "Close support chat" : "Open support chat");
  });

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(button);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
