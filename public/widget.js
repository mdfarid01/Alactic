/*! Alactic website widget — loads the chat in an isolated iframe. No cookies or data from the host page are read. */
(function () {
  var script = document.currentScript || document.querySelector('script[data-agent][src*="widget.js"]');
  if (!script || window.__alacticWidget) return;
  var slug = script.getAttribute("data-agent") || "";
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) return console.warn("[Alactic] invalid data-agent");
  window.__alacticWidget = true;
  var base = new URL(script.src, location.href).origin;
  var color = script.getAttribute("data-color") || "#111111";

  var button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Open chat");
  button.setAttribute("aria-expanded", "false");
  button.innerHTML =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  Object.assign(button.style, {
    position: "fixed", right: "20px", bottom: "20px", width: "56px", height: "56px", borderRadius: "999px", border: "none",
    background: color, cursor: "pointer", boxShadow: "0 6px 24px rgba(0,0,0,.2)", zIndex: "2147483646",
    display: "flex", alignItems: "center", justifyContent: "center",
  });

  var frame = document.createElement("iframe");
  frame.src = base + "/embed/" + encodeURIComponent(slug);
  frame.title = "Chat with support";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  Object.assign(frame.style, {
    position: "fixed", right: "20px", bottom: "88px", width: "min(380px, calc(100vw - 40px))", height: "min(600px, calc(100vh - 120px))",
    border: "1px solid rgba(0,0,0,.1)", borderRadius: "16px", boxShadow: "0 12px 48px rgba(0,0,0,.25)", zIndex: "2147483647",
    display: "none", background: "white", colorScheme: "normal",
  });

  button.addEventListener("click", function () {
    var open = frame.style.display === "none";
    frame.style.display = open ? "block" : "none";
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close chat" : "Open chat");
  });

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(button);
  }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
