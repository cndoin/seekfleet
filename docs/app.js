const repository = document.documentElement.dataset.repository || "https://github.com/cndoin/seekfleet";

document.querySelectorAll("[data-repo-link]").forEach((link) => {
  link.href = repository;
  if (repository) {
    link.target = "_blank";
    link.rel = "noreferrer";
  }
});

const prompt = document.querySelector("#ai-prompt code");
if (prompt) prompt.textContent = prompt.textContent.replaceAll("REPOSITORY_URL", repository);

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);
    if (!target) return;
    await navigator.clipboard.writeText(target.textContent.trim());
    const toast = document.querySelector(".toast");
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 1800);
  });
});
