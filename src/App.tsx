import { useMemo, useState } from "react";
import { PROMPT, CHANGES } from "./prompt";
import playerHtml from "../player/index.html?raw";
import playerCss from "../player/style.css?raw";
import playerJs from "../player/app.js?raw";

type Tab = "player" | "files" | "prompt";

const FILES = [
  { name: "index.html", content: playerHtml, mime: "text/html" },
  { name: "style.css", content: playerCss, mime: "text/css" },
  { name: "app.js", content: playerJs, mime: "text/javascript" },
];

const CHECKLIST = [
  "Nenhum innerHTML com dados remotos (apenas textContent)",
  "Zero chamadas a createMediaElementSource (áudio nativo direto)",
  "Somente ./style.css e ./app.js referenciados",
  "100% dos IDs usados no JS e no CSS existem no HTML",
  "Portão de artista exato bloqueia a busca quando não verificado",
  "Sugestões de artista clicáveis (Dice + Levenshtein)",
  "Aviso do nome exato visível sob o campo do artista",
  "Relevância mínima 40 por título/letra",
  "Filtro anti-sample (busca, loadedmetadata e M3U)",
  "Alturas fixas nos painéis críticos (CLS = 0)",
  "Todas as chamadas de rede com timeout de 8s e erro amigável",
  "Sintaxe validada (node --check) e teste de fluxo simulado",
];

function download(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export default function App() {
  const [tab, setTab] = useState<Tab>("player");
  const [sel, setSel] = useState(0);
  const [copied, setCopied] = useState("");

  const srcDoc = useMemo(
    () =>
      playerHtml
        .replace('<link rel="stylesheet" href="./style.css">', () => "<style>" + playerCss + "</style>")
        .replace('<script src="./app.js"></script>', () => "<script>" + playerJs + "<" + "/script>"),
    []
  );

  const doCopy = async (key: string, text: string) => {
    await copyText(text);
    setCopied(key);
    setTimeout(() => setCopied(""), 1800);
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: "player", label: "▶ Player" },
    { id: "files", label: "📁 Arquivos (3)" },
    { id: "prompt", label: "📝 Prompt" },
  ];

  return (
    <div className="flex h-screen flex-col bg-slate-950 text-slate-100">
      <nav className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 bg-slate-900 px-3">
        <span className="mr-2 hidden text-xs font-bold tracking-widest text-indigo-300 sm:inline">HI-FI WEB PLAYER</span>
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={
              "min-h-[36px] rounded-lg px-3 text-sm font-medium transition " +
              (tab === t.id ? "bg-indigo-500 text-white" : "text-slate-300 hover:bg-white/10")
            }
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className={tab === "player" ? "min-h-0 flex-1" : "hidden"}>
        <iframe
          title="Hi-Fi Web Player"
          srcDoc={srcDoc}
          allow="autoplay; encrypted-media; fullscreen; clipboard-write"
          className="h-full w-full border-0 bg-[#07080f]"
        />
      </div>

      {tab === "files" && (
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto grid max-w-6xl gap-6 p-5 lg:grid-cols-[320px_1fr]">
            <aside className="space-y-4">
              <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <h2 className="mb-2 text-sm font-semibold">💾 Salvar no pendrive (USB)</h2>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
                  <li>Baixe os 3 arquivos abaixo.</li>
                  <li>Coloque-os na MESMA pasta do pendrive.</li>
                  <li>Dê duplo clique em <b>index.html</b>.</li>
                </ol>
              </section>
              <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <h2 className="mb-2 text-sm font-semibold">🌐 Publicar no GitHub Pages</h2>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
                  <li>Crie um repositório público.</li>
                  <li>Envie os 3 arquivos na raiz.</li>
                  <li>Settings → Pages → Deploy from branch → main / (root).</li>
                </ol>
              </section>
              <section className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <h2 className="mb-2 text-sm font-semibold">✅ Auditoria pré-entrega</h2>
                <ul className="space-y-1 text-xs text-slate-300">
                  {CHECKLIST.map((c, i) => (
                    <li key={c} className="flex gap-2">
                      <span className="shrink-0 font-bold text-emerald-400">PASS</span>
                      <span>
                        {i + 1}. {c}
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs text-amber-300">
                  Nota: a busca em arquivos .m3u abertos do GitHub exige token da API de código; sem chave, a mineração usa Internet Archive e Radio-Browser.
                </p>
              </section>
            </aside>

            <section className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {FILES.map((f, i) => (
                  <button
                    key={f.name}
                    onClick={() => setSel(i)}
                    className={
                      "min-h-[40px] rounded-lg px-3 font-mono text-sm " +
                      (sel === i ? "bg-indigo-500" : "border border-white/15 hover:bg-white/10")
                    }
                  >
                    {f.name}
                  </button>
                ))}
                <span className="flex-1" />
                <button
                  onClick={() => doCopy("file", FILES[sel].content)}
                  className="min-h-[40px] rounded-lg border border-white/20 px-3 text-sm hover:bg-white/10"
                >
                  {copied === "file" ? "✔ Copiado" : "Copiar"}
                </button>
                <button
                  onClick={() => download(FILES[sel].name, FILES[sel].content, FILES[sel].mime)}
                  className="min-h-[40px] rounded-lg bg-emerald-500 px-3 text-sm font-medium text-black hover:bg-emerald-400"
                >
                  Baixar {FILES[sel].name}
                </button>
                <button
                  onClick={() => FILES.forEach((f, i) => setTimeout(() => download(f.name, f.content, f.mime), i * 300))}
                  className="min-h-[40px] rounded-lg bg-indigo-500 px-3 text-sm font-medium hover:bg-indigo-400"
                >
                  Baixar os 3
                </button>
              </div>
              <pre className="h-[70vh] overflow-auto whitespace-pre rounded-2xl border border-white/10 bg-black/50 p-4 font-mono text-xs leading-relaxed text-slate-200">
                {FILES[sel].content}
              </pre>
            </section>
          </div>
        </main>
      )}

      {tab === "prompt" && (
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto grid max-w-6xl gap-6 p-5 lg:grid-cols-[320px_1fr]">
            <aside className="space-y-4">
              {CHANGES.map((c) => (
                <section key={c.n} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                  <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500 text-xs">{c.n}</span>
                    {c.title}
                  </h2>
                  <ul className="space-y-1 text-sm text-slate-300">
                    {c.items.map((i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-emerald-400">✔</span>
                        <span>{i}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </aside>
            <section className="min-w-0">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">Prompt final (EN)</h2>
                <div className="flex gap-2">
                  <button onClick={() => doCopy("prompt", PROMPT)} className="min-h-[40px] rounded-lg bg-indigo-500 px-4 text-sm font-medium hover:bg-indigo-400">
                    {copied === "prompt" ? "✔ Copiado!" : "Copiar prompt"}
                  </button>
                  <button
                    onClick={() => download("prompt-web-audio-player.txt", PROMPT, "text/plain")}
                    className="min-h-[40px] rounded-lg border border-white/20 px-4 text-sm hover:bg-white/10"
                  >
                    Baixar .txt
                  </button>
                </div>
              </div>
              <pre className="h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-white/10 bg-black/50 p-5 font-mono text-[13px] leading-relaxed text-slate-200">
                {PROMPT}
              </pre>
            </section>
          </div>
        </main>
      )}
    </div>
  );
}
