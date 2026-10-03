import type { ReactNode } from "react";
import { Activity, Database, FilePlus, FileText, LogOut, Mic, Search, Server, Settings } from "lucide-react";
import { isRemote, remoteLogout } from "@/lib/remote";

/** Botao de ferramenta do Studio (barra lateral; na barra de abas quando a lateral esta recolhida). */
export interface StudioAction {
  id: string;
  label: string;
  title: string;
  icon: ReactNode;
  onClick: () => void;
  /** menor = vai primeiro para o "..." quando falta espaco */
  priority: number;
}

export interface StudioActionHandlers {
  onSearch: () => void;
  onGeneral: () => void;
  onTaskManager?: () => void;
  onDatabase?: () => void;
  onTools?: () => void;
  onOpenFile?: () => void;
  onNewFile?: () => void;
  onSpeak?: () => void;
}

export function buildStudioActions(h: StudioActionHandlers): StudioAction[] {
  const acts: StudioAction[] = [];
  if (h.onTools)
    acts.push({
      id: "tools",
      label: "SSH e Serial",
      title: "SSH e Serial: hosts SSH salvos, arquivos (SFTP) e portas seriais",
      icon: <Server size={16} />,
      onClick: h.onTools,
      priority: 2,
    });
  if (h.onOpenFile)
    acts.push({
      id: "file",
      label: "Abrir arquivo",
      title: "Abrir arquivo: ver e editar texto e Markdown (.md, .txt, .log) ou ver imagem",
      icon: <FileText size={16} />,
      onClick: h.onOpenFile,
      priority: 3,
    });
  if (h.onNewFile)
    acts.push({
      id: "newfile",
      label: "Novo arquivo",
      title: "Novo arquivo: abre o editor em branco para escrever; salvar é opcional (aí escolhe pasta e nome)",
      icon: <FilePlus size={16} />,
      onClick: h.onNewFile,
      priority: 3,
    });
  if (h.onSpeak)
    acts.push({
      id: "speak",
      label: "Falar",
      title: "Falar: ditar um texto para o terminal em foco",
      icon: <Mic size={16} />,
      onClick: h.onSpeak,
      priority: 4,
    });
  acts.push({
    id: "search",
    label: "Buscar",
    title: "Buscar: ir para um terminal (título, pasta, aba, número ou texto na tela)",
    icon: <Search size={16} />,
    onClick: h.onSearch,
    priority: 5,
  });
  if (h.onTaskManager)
    acts.push({
      id: "tasks",
      label: "Tarefas",
      title: "Gerenciador de tarefas: memória, CPU, GPU, disco, consumo de cada terminal e do WSL",
      icon: <Activity size={16} />,
      onClick: h.onTaskManager,
      priority: 1,
    });
  if (h.onDatabase)
    acts.push({
      id: "db",
      label: "Banco de dados",
      title: "Banco de dados: conexões salvas, tabelas e consultas SQL",
      icon: <Database size={16} />,
      onClick: h.onDatabase,
      priority: 0,
    });
  if (isRemote())
    acts.push({
      id: "remote-exit",
      label: "Sair",
      title: "Sair do Studio remoto neste navegador (o PC e os terminais continuam como estão)",
      icon: <LogOut size={16} />,
      onClick: remoteLogout,
      priority: 8,
    });
  acts.push({
    id: "settings",
    label: "Configurações",
    title: "Configurações: aparência, terminais, voz e IA, provedores, barra lateral e sobre",
    icon: <Settings size={16} />,
    onClick: h.onGeneral,
    priority: 9,
  });
  return acts;
}
