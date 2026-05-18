document.addEventListener("DOMContentLoaded", () => {
  const samePageLinks = document.querySelectorAll('a[href^="#"]');
  const faqItems = document.querySelectorAll(".faq-item");

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
});
