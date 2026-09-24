(() => {
  interface OutsideHoursPresentation {
    state?: string;
    display?: "bouncing_logo" | "custom_text" | "black";
    text?: string;
    textColor?: string;
  }

  interface OutsideHoursBridge {
    onPresent(callback: (presentation: OutsideHoursPresentation) => void): void;
  }

  const bridge = (window as unknown as { tilecast: OutsideHoursBridge })
    .tilecast;

  const style = document.createElement("style");
  style.textContent = `
    #outside-hours-overlay {
      position: absolute;
      inset: 0;
      z-index: 25;
      display: none;
      overflow: hidden;
      background: #000;
      pointer-events: none;
    }
    #outside-hours-overlay.visible {
      display: block;
    }
    #outside-hours-overlay.custom-text {
      display: flex;
      box-sizing: border-box;
      align-items: center;
      justify-content: center;
      padding: 80px;
      text-align: center;
    }
    #outside-hours-overlay .outside-hours-text {
      max-width: 80%;
      font-size: clamp(28px, 3.3vw, 56px);
      font-weight: 500;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    #outside-hours-overlay .outside-hours-logo-x {
      position: absolute;
      top: 0;
      left: 0;
      width: 250px;
      height: 76px;
      animation: tilecast-outside-hours-x 12s linear infinite alternate;
    }
    #outside-hours-overlay .outside-hours-logo-y {
      display: block;
      width: 250px;
      height: 76px;
      object-fit: contain;
      animation: tilecast-outside-hours-y 8.5s linear infinite alternate;
    }
    @keyframes tilecast-outside-hours-x {
      from { transform: translateX(0); }
      to { transform: translateX(max(0px, calc(100vw - 250px))); }
    }
    @keyframes tilecast-outside-hours-y {
      from { transform: translateY(0); }
      to { transform: translateY(max(0px, calc(100vh - 76px))); }
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "outside-hours-overlay";
  document.body.appendChild(overlay);

  function hide(): void {
    overlay.className = "";
    overlay.replaceChildren();
  }

  function showBlack(): void {
    overlay.replaceChildren();
    overlay.className = "visible";
  }

  function showCustomText(presentation: OutsideHoursPresentation): void {
    const text = document.createElement("div");
    text.className = "outside-hours-text";
    text.textContent = presentation.text?.trim() || "Powered by Tilecast";
    text.style.color = presentation.textColor || "#F5F7FA";
    overlay.replaceChildren(text);
    overlay.className = "visible custom-text";
  }

  function showBouncingLogo(): void {
    const horizontal = document.createElement("div");
    horizontal.className = "outside-hours-logo-x";

    const logo = document.createElement("img");
    logo.className = "outside-hours-logo-y";
    logo.src = "./tilecast-logo-white.svg";
    logo.alt = "Tilecast";

    horizontal.appendChild(logo);
    overlay.replaceChildren(horizontal);
    overlay.className = "visible";
  }

  bridge.onPresent((presentation) => {
    if (presentation.state !== "sleep") {
      hide();
      return;
    }

    if (presentation.display === "bouncing_logo") {
      showBouncingLogo();
      return;
    }

    if (presentation.display === "custom_text") {
      showCustomText(presentation);
      return;
    }

    if (presentation.display === "black") {
      showBlack();
      return;
    }

    hide();
  });
})();
