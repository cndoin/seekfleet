document.documentElement.classList.add("js");

const repository = document.documentElement.dataset.repository || "https://github.com/cndoin/seekfleet";
const productPage = "https://cndoin.github.io/seekfleet/";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

document.querySelectorAll("[data-repo-link]").forEach((link) => {
  link.href = repository;
  link.target = "_blank";
  link.rel = "noreferrer";
});

document.querySelectorAll("[data-pages-link]").forEach((link) => {
  link.href = productPage;
  link.target = "_blank";
  link.rel = "noreferrer";
});

const progress = document.querySelector(".scroll-progress span");
const updateProgress = () => {
  if (!progress) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  progress.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
};
window.addEventListener("scroll", updateProgress, { passive: true });
updateProgress();

const revealItems = document.querySelectorAll("[data-reveal]");
if (reducedMotion || !("IntersectionObserver" in window)) {
  revealItems.forEach((item) => item.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12 },
  );
  revealItems.forEach((item) => revealObserver.observe(item));
}

const counter = (element, target) => {
  const duration = 900;
  const started = performance.now();
  const tick = (now) => {
    const progressValue = Math.min((now - started) / duration, 1);
    const eased = 1 - Math.pow(1 - progressValue, 3);
    const value = Math.round(target * eased);
    if (element.dataset.counter === "284") element.textContent = `${value}k`;
    else if (element.dataset.counter === "4") element.textContent = String(value).padStart(2, "0");
    else element.innerHTML = `${value}<span>%</span>`;
    if (progressValue < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

document.querySelectorAll("[data-counter]").forEach((element) => {
  if (reducedMotion) return;
  const target = Number(element.dataset.counter);
  counter(element, target);
});

const latency = document.querySelector("[data-live-latency]");
if (latency && !reducedMotion) {
  window.setInterval(() => {
    latency.textContent = `${38 + Math.floor(Math.random() * 13)} ms`;
  }, 1800);
}

if (!reducedMotion) {
  window.addEventListener(
    "pointermove",
    (event) => {
      document.body.style.setProperty("--mx", `${event.clientX}px`);
      document.body.style.setProperty("--my", `${event.clientY}px`);
    },
    { passive: true },
  );

  const tilt = document.querySelector("[data-tilt]");
  if (tilt && window.matchMedia("(pointer: fine)").matches) {
    tilt.addEventListener("pointermove", (event) => {
      const rect = tilt.getBoundingClientRect();
      const x = (event.clientX - rect.left) / rect.width - 0.5;
      const y = (event.clientY - rect.top) / rect.height - 0.5;
      tilt.style.transform = `perspective(1200px) rotateY(${x * 5 - 1}deg) rotateX(${y * -4 + 1}deg) translateY(-5px)`;
    });
    tilt.addEventListener("pointerleave", () => {
      tilt.style.transform = "";
    });
  }
}

const copyText = async (value) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const helper = document.createElement("textarea");
  helper.value = value;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
};

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    try {
      await copyText(target.textContent.trim());
      const toast = document.querySelector(".toast");
      if (toast) {
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 1800);
      }
      button.textContent = "已复制 ✓";
      setTimeout(() => (button.textContent = "复制"), 1800);
    } catch {
      button.textContent = "请手动复制";
      setTimeout(() => (button.textContent = "复制"), 1800);
    }
  });
});
