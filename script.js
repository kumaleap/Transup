document.addEventListener("DOMContentLoaded", () => {
  const samePageLinks = document.querySelectorAll('a[href^="#"]');
  const faqItems = document.querySelectorAll(".faq-item");
  const interactiveHero = document.querySelector("[data-interactive-hero]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  samePageLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetId = link.getAttribute("href");

      if (!targetId || targetId === "#") {
        return;
      }

      const target = document.querySelector(targetId);

      if (!target) {
        return;
      }

      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "start" });
      history.pushState(null, "", targetId);
    });
  });

  faqItems.forEach((item) => {
    item.addEventListener("click", () => {
      const isExpanded = item.getAttribute("aria-expanded") === "true";
      item.setAttribute("aria-expanded", String(!isExpanded));
    });
  });

  if (interactiveHero && !reduceMotion.matches) {
    let rafId = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;

    const render = () => {
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;

      interactiveHero.style.setProperty("--mx", currentX.toFixed(4));
      interactiveHero.style.setProperty("--my", currentY.toFixed(4));

      if (Math.abs(targetX - currentX) > 0.001 || Math.abs(targetY - currentY) > 0.001) {
        rafId = window.requestAnimationFrame(render);
      } else {
        rafId = 0;
      }
    };

    const requestRender = () => {
      if (!rafId) {
        rafId = window.requestAnimationFrame(render);
      }
    };

    interactiveHero.addEventListener("pointermove", (event) => {
      if (window.innerWidth < 900) {
        return;
      }

      const bounds = interactiveHero.getBoundingClientRect();
      targetX = ((event.clientX - bounds.left) / bounds.width - 0.5) * 2;
      targetY = ((event.clientY - bounds.top) / bounds.height - 0.5) * 2;
      requestRender();
    });

    interactiveHero.addEventListener("pointerleave", () => {
      targetX = 0;
      targetY = 0;
      requestRender();
    });
  }
});
