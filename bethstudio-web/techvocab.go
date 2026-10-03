package main

// techvocab.go — "Vocabulario tecnico padrao" do corretor de voz: termos
// de desenvolvimento com a grafia correta, por categoria. Vai inteiro no
// prompt da CORRECAO (junto com o vocabulario do usuario, sem repetir) e,
// na TRANSCRICAO, so' um subconjunto curto (o prompt do Whisper e' curto).

import (
	"strings"
	"unicode/utf8"
)

type vocabCategory struct {
	Name  string   `json:"name"`
	Terms []string `json:"terms"`
}

var techVocab = []vocabCategory{
	{"Linguagens", []string{
		"C", "C++", "C#", "F#", "Go", "Golang", "Rust", "Python", "JavaScript", "TypeScript", "Java", "Kotlin", "Swift",
		"PHP", "Ruby", "Lua", "Zig", "Dart",
		"Delphi", "Visual Basic", "Assembly", "WebAssembly", "SQL", "Bash", "PowerShell",
		"HTML", "CSS", "Markdown", "LaTeX", "GraphQL",
	}},
	{"IA e LLM", []string{
		"OpenAI", "ChatGPT", "GPT", "GPT-4", "GPT-4o", "GPT-4.1", "GPT-5", "o3", "o4-mini", "Codex", "Whisper",
		"Claude", "Claude Code", "Anthropic", "Sonnet", "Opus", "Haiku", "Gemini", "Vertex AI", "DeepSeek",
		"Llama", "Mistral", "Qwen", "Grok", "Groq", "DeepInfra",
		"OpenRouter", "Hugging Face", "Ollama", "llama.cpp",
		"LangChain", "LlamaIndex", "Copilot", "GitHub Copilot", "Cursor", "MCP",
		"Model Context Protocol", "RAG", "embeddings", "vector store", "prompt", "system prompt", "token", "tokens",
		"tokenizer", "fine-tuning", "LoRA", "inference", "LLM", "agent", "tool calling", "function calling",
		"streaming", "context window", "temperature", "hallucination",
		"PyTorch", "TensorFlow", "CUDA", "NVIDIA", "GPU",
	}},
	{"Ferramentas e infraestrutura", []string{
		"Git", "GitHub", "GitLab", "Bitbucket", "GitHub Actions", "Docker", "Docker Compose", "Dockerfile",
		"Kubernetes", "k8s", "kubectl", "Helm", "Terraform", "Ansible", "nginx", "Apache", "Redis",
		"PostgreSQL", "Postgres", "MySQL", "MariaDB", "SQLite", "SQL Server", "MongoDB", "Elasticsearch",
		"Kafka", "RabbitMQ", "MQTT", "Prometheus", "Grafana", "OpenTelemetry", "Sentry", "Wireshark",
		"tcpdump", "curl", "Postman", "jq", "grep", "sed", "awk", "SSH",
		"SFTP", "SCP", "rsync", "OpenSSH", "PuTTY", "WSL", "WSL2", "VS Code", "Visual Studio", "Neovim", "Vim",
		"JetBrains", "tmux", "Windows Terminal", "WezTerm", "npm", "pnpm", "Yarn", "Bun", "Deno",
		"Node.js", "Vite", "ESLint", "Prettier", "Jest", "Vitest", "Playwright",
		"React", "React Native", "Expo", "Next.js", "Vue", "Svelte", "Angular", "Tailwind",
		"Tailwind CSS", "Express", "Django", "Flask", "FastAPI", "Spring Boot", "Laravel", "Rails",
		"ASP.NET", ".NET", "Electron", "Tauri", "Flutter", "Xcode", "Android Studio", "Gradle", "Maven", "NuGet",
		"pip", "uv", "venv", "Go modules", "go.mod", "Cargo", "rustc", "rustup",
		"CMake", "Make", "Makefile", "gcc", "g++", "clang", "LLVM", "MSVC", "MinGW", "GDB",
		"Homebrew", "Chocolatey", "winget", "apt", "systemd", "systemctl",
		"journalctl", "cron", "Jenkins", "AWS", "Amazon S3",
		"Azure", "Google Cloud", "Cloudflare", "Vercel", "Supabase", "Firebase", "Tailscale", "WireGuard",
		"Let's Encrypt", "Swagger", "OpenAPI",
	}},
	{"Protocolos e conceitos", []string{
		"HTTP", "HTTPS", "HTTP/2", "REST", "gRPC", "protobuf", "WebSocket", "WebRTC", "JSON",
		"NDJSON", "YAML", "TOML", "XML", "CSV", "TCP", "UDP", "IPv4", "IPv6", "DNS", "VPN", "TLS", "SSL",
		"OAuth", "OAuth2", "OpenID Connect", "JWT", "SSO", "CORS", "API", "API key", "SDK",
		"CLI", "GUI", "TUI", "CI/CD", "DevOps", "commit", "merge", "rebase", "cherry-pick",
		"pull request", "merge request", "branch", "checkout", "release", "hotfix",
		"push", "pull", "deploy", "rollback", "staging", "production", "endpoint", "backend",
		"frontend", "full stack", "framework", "refactor",
		"stack trace", "timeout", "cache", "localhost", "proxy", "reverse proxy", "load balancer", "webhook",
		"middleware", "payload", "status code", "async", "await", "promise",
		"thread", "mutex", "deadlock", "race condition", "garbage collector", "heap", "buffer", "null", "undefined",
		"struct", "interface", "generics", "regex", "UTF-8",
		"Unicode", "SHA-256", "UUID", "ORM", "migration", "schema", "query",
		"transaction", "microservices", "serverless", "container", "pod", "cluster",
		"ingress", "pub/sub", "idempotente", "latency", "throughput", "profiling", "linter", "formatter",
		"unit test", "mock", "coverage", "TDD", "README", "changelog",
		"code review", "PTY", "TTY", "stdin", "stdout", "stderr", "ANSI", "escape sequence",
		"toolchain", "cross-compile",
	}},
	{"Sistemas operacionais e Windows", []string{
		"Windows", "Windows 11", "Windows Server", "Linux", "Ubuntu", "Debian", "Fedora", "Arch Linux",
		"macOS", "ConPTY", "conhost", "registry", "PID", "UAC",
		"Task Manager", "Gerenciador de Tarefas", "Hyper-V", "NTFS", "kernel",
		"driver", "daemon", "sudo", "chmod", "chown", "PATH", "APPDATA", "DPAPI", "WebView2", "DLL",
		"RDP", "firewall", "Defender",
	}},
	{"Palavras do dia a dia", []string{
		"build", "bug", "fix", "feature", "log", "logs", "debug", "setup", "script", "server", "client", "cloud",
		"update", "download", "upload", "login", "dashboard", "workflow", "pipeline",
		"plugin", "callback", "config", "settings", "backup", "reset", "crash",
		"performance", "trade-off", "workaround",
	}},
}

// techTop: os mais frequentes, para o prompt curto do Whisper (a ordem e' a
// prioridade no corte).
var techTop = []string{
	"OpenAI", "ChatGPT", "Claude", "Claude Code", "Anthropic", "Gemini", "DeepSeek", "Llama", "Mistral", "Qwen",
	"Whisper", "Ollama", "DeepInfra", "Groq", "MCP", "LLM", "RAG", "prompt", "token", "C#", "C++", "Go", "Rust",
	"Python", "JavaScript", "TypeScript", "Java", "Kotlin", "PHP", "SQL", "Bash", "PowerShell", "Git", "GitHub",
	"GitLab", "Docker", "Kubernetes", "kubectl", "Terraform", "nginx", "Redis", "PostgreSQL", "MySQL", "SQLite",
	"MongoDB", "Kafka", "Wireshark", "curl", "SSH", "WSL", "VS Code", "Neovim", "tmux", "npm", "pnpm", "Node.js",
	"Vite", "React", "Next.js", "Tailwind", "JSON", "YAML", "HTTP", "gRPC", "WebSocket", "API", "CLI", "CI/CD",
	"commit", "merge", "rebase", "pull request", "branch", "deploy", "endpoint", "backend", "frontend", "debug",
	"stack trace", "timeout", "localhost", "Linux", "Ubuntu", "Debian", "Windows", "macOS",
}

// Exemplos foneticos (como o reconhecimento em pt-BR costuma errar) para o
// prompt da correcao.
var techPhonetic = [][2]string{
	{"c sharp / si sharp / cê sharp", "C#"},
	{"sê mais mais / c mais mais / si plus plus", "C++"},
	{"f sharp", "F#"},
	{"open ai / open aid / openaid / ópen ei ai", "OpenAI"},
	{"dip sik / deep seq / deepseq / dipsique", "DeepSeek"},
	{"uaiarxarc / wire shark / uáiar xárque", "Wireshark"},
	{"git rab / guit hub / gitirrabi", "GitHub"},
	{"dóquer / doquer", "Docker"},
	{"cubernetes / kubernetis / cubernétis", "Kubernetes"},
	{"cube control / cube ctl / kube cuttle", "kubectl"},
	{"jêison / jason (formato)", "JSON"},
	{"iâmou / yamel", "YAML"},
	{"póstgres / postgree / postgre sql", "PostgreSQL"},
	{"rédis / rédiz", "Redis"},
	{"engine x / enginecs", "nginx"},
	{"taipe script / tipescript", "TypeScript"},
	{"java script / djava script", "JavaScript"},
	{"paiton / pai tom / páiton", "Python"},
	{"ráste / rást (linguagem)", "Rust"},
	{"gô lang / golangue", "Go"},
	{"cláudi / clódi (o assistente)", "Claude"},
	{"gêmini / jeminai", "Gemini"},
	{"uísper / uíspe", "Whisper"},
	{"lhama / lama (o modelo)", "Llama"},
	{"vi es code / vê esse code", "VS Code"},
	{"dáblio es ele / uésel", "WSL"},
	{"pau shell / power xel / páuer xél", "PowerShell"},
	{"ci cd / cê i cê dê", "CI/CD"},
	{"gi ar pi ci / gê erre pê cê", "gRPC"},
	{"eme cê pê", "MCP"},
	{"quiube / cube ctl", "kubectl"},
	{"nôde jês / node js", "Node.js"},
	{"next jês / next js", "Next.js"},
	{"tailuind / tail wind", "Tailwind"},
	{"ól ama / olhama", "Ollama"},
	{"dip infra / deep infra", "DeepInfra"},
	{"grók (provedor)", "Groq"},
}

// techVocabFlat: todas as categorias, sem repetir (grafia da primeira vez).
func techVocabFlat() []string {
	var out []string
	seen := map[string]bool{}
	for _, c := range techVocab {
		for _, t := range c.Terms {
			k := strings.ToLower(t)
			if !seen[k] {
				seen[k] = true
				out = append(out, t)
			}
		}
	}
	return out
}

// mergeVocab: termos do usuario primeiro, depois os tecnicos; sem repetir
// (comparacao sem maiusculas; vale a grafia do usuario).
func mergeVocab(user, tech []string) []string {
	out := make([]string, 0, len(user)+len(tech))
	seen := map[string]bool{}
	for _, list := range [][]string{user, tech} {
		for _, t := range list {
			t = strings.TrimSpace(t)
			k := strings.ToLower(t)
			if t == "" || seen[k] {
				continue
			}
			seen[k] = true
			out = append(out, t)
		}
	}
	return out
}

func techEnabled(v VoiceSettings) bool { return v.TechVocab == nil || *v.TechVocab }

// correctionVocab: {vocabulario} do prompt da correcao (um termo por linha).
func correctionVocab(v VoiceSettings) string {
	user := vocabularyTerms(v.Vocabulary)
	if !techEnabled(v) {
		return strings.Join(user, "\n")
	}
	return strings.Join(mergeVocab(user, techVocabFlat()), "\n")
}

// whisperPromptMaxChars: o prompt do Whisper aceita ~224 tokens; termos
// tecnicos quebram em ~2,5–3 caracteres por token, entao ficamos em 560.
const whisperPromptMaxChars = 560

// transcriptionVocab: vocabulario do usuario + os tecnicos mais frequentes,
// cortado para caber no prompt do Whisper (os do usuario vem antes e so'
// sao cortados se, sozinhos, passarem do limite).
func transcriptionVocab(v VoiceSettings) string {
	user := vocabularyTerms(v.Vocabulary)
	all := user
	if techEnabled(v) {
		all = mergeVocab(user, techTop)
	}
	return strings.Join(fitTerms(all, whisperPromptMaxChars), "\n")
}

// fitTerms: os primeiros termos que cabem em max caracteres, juntos por ", ".
func fitTerms(terms []string, max int) []string {
	var out []string
	n := 0
	for _, t := range terms {
		add := utf8.RuneCountInString(t)
		if len(out) > 0 {
			add += 2 // ", "
		}
		if n+add > max {
			break
		}
		n += add
		out = append(out, t)
	}
	return out
}

// phoneticTable: bloco do prompt da correcao com os exemplos foneticos.
func phoneticTable() string {
	var sb strings.Builder
	for _, p := range techPhonetic {
		sb.WriteString("- \"")
		sb.WriteString(p[0])
		sb.WriteString("\" → ")
		sb.WriteString(p[1])
		sb.WriteString("\n")
	}
	return strings.TrimRight(sb.String(), "\n")
}
