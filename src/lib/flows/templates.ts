/**
 * Starter flow templates.
 *
 * Three pre-canned flows users can clone with one click instead of
 * building from scratch. Each template is a plain JS object describing
 * the same shape `/api/flows` PUT accepts — name, trigger config,
 * entry_node_id, fallback_policy, nodes[] — keyed by a stable
 * `slug`.
 *
 * The clone path (`/api/flows` POST with `template_slug`) creates a
 * NEW flow_row + flow_nodes rows for the user. `node_key`s are kept
 * verbatim (they're stable strings, not UUIDs, so cloning never
 * needs to rewrite edge references).
 *
 * Choosing a single static module over a DB-backed gallery for v1
 * because: (a) the set is small and changes with code releases, not
 * data; (b) keeps templates portable across self-hosted instances
 * without migrations; (c) editing in source is the lowest-friction
 * way to add the next template.
 */

import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  StartNodeConfig,
} from "./types";

export type FlowTemplateNodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "collect_input"
  | "condition"
  | "set_tag"
  | "handoff"
  | "end";

export interface FlowTemplateNode {
  node_key: string;
  node_type: FlowTemplateNodeType;
  config:
    | StartNodeConfig
    | SendMessageNodeConfig
    | SendButtonsNodeConfig
    | SendListNodeConfig
    | CollectInputNodeConfig
    | ConditionNodeConfig
    | HandoffNodeConfig
    | Record<string, unknown>;
}

export interface FlowTemplate {
  slug: string;
  name: string;
  description: string;
  /** Used by the gallery to surface a relevant icon. lucide-react name. */
  icon: "MessageSquare" | "HelpCircle" | "UserPlus" | "Building2";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: KeywordTriggerConfig | Record<string, unknown>;
  entry_node_id: string;
  nodes: FlowTemplateNode[];
}

// ============================================================
// 1. Welcome menu — the example from the owner's brief
// ============================================================
const WELCOME_MENU: FlowTemplate = {
  slug: "welcome_menu",
  name: "Welcome menu",
  description:
    "Greet customers who type a keyword and route them to the right agent based on whether they're new or existing.",
  icon: "MessageSquare",
  trigger_type: "keyword",
  trigger_config: { keywords: ["support", "help", "hi"], match_type: "contains" },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_buttons",
      config: {
        text: "Hi! 👋 Welcome to support. Are you an existing customer or new here?",
        footer_text: "Tap a button below to continue.",
        buttons: [
          {
            reply_id: "existing",
            title: "Existing customer",
            next_node_key: "existing_handoff",
          },
          {
            reply_id: "new",
            title: "New customer",
            next_node_key: "new_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "existing_handoff",
      node_type: "handoff",
      config: {
        note: "Existing customer needs assistance — please check account history before replying.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "new_handoff",
      node_type: "handoff",
      config: {
        note: "New customer — share pricing + onboarding link.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 2. FAQ bot — list-message answers, fully automated
// ============================================================
const FAQ_BOT: FlowTemplate = {
  slug: "faq_bot",
  name: "FAQ bot",
  description:
    "Answer common questions automatically. Customer picks a topic from a list; the bot replies with the answer and ends.",
  icon: "HelpCircle",
  trigger_type: "keyword",
  trigger_config: {
    keywords: ["faq", "question", "info"],
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "topics" },
    },
    {
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: "What can I help you with?",
        button_label: "View topics",
        sections: [
          {
            title: "Common questions",
            rows: [
              {
                reply_id: "hours",
                title: "Opening hours",
                next_node_key: "answer_hours",
              },
              {
                reply_id: "pricing",
                title: "Pricing",
                next_node_key: "answer_pricing",
              },
              {
                reply_id: "refunds",
                title: "Refund policy",
                next_node_key: "answer_refunds",
              },
            ],
          },
          {
            title: "Other",
            rows: [
              {
                reply_id: "human",
                title: "Talk to a human",
                next_node_key: "human_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "answer_hours",
      node_type: "send_message",
      config: {
        text: "We're open Mon–Fri, 9am–6pm local time. Weekend support is limited to urgent issues.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_pricing",
      node_type: "send_message",
      config: {
        text: "Our pricing starts at $9/mo. Visit https://example.com/pricing for the full breakdown.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_refunds",
      node_type: "send_message",
      config: {
        text: "Refunds are honored within 30 days of purchase. Reply with your order number and we'll process it.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        note: "Customer asked to talk to a human from the FAQ bot.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// 3. Lead capture — collect_input chain, ends in a handoff
// ============================================================
const LEAD_CAPTURE: FlowTemplate = {
  slug: "lead_capture",
  name: "Lead capture",
  description:
    "Greet first-time inbounds, capture name + email + company, then hand off to sales with the answers in the note.",
  icon: "UserPlus",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" },
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: "Welcome! 👋 I'll ask a few quick questions so we can get you to the right person.",
        next_node_key: "ask_name",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: "What's your name?",
        var_key: "name",
        next_node_key: "ask_email",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_email",
      node_type: "collect_input",
      config: {
        prompt_text: "Thanks {{vars.name}}! What's your work email?",
        var_key: "email",
        next_node_key: "ask_company",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_company",
      node_type: "collect_input",
      config: {
        prompt_text: "Almost done — what's your company name?",
        var_key: "company",
        next_node_key: "handoff",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: "New lead — name={{vars.name}}, email={{vars.email}}, company={{vars.company}}.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 4. BSign Estudio — full business menu, tailored to the studio's
//    real workflow (shop / design-appointment booking / portfolio /
//    order status / hours / human handoff). Replaces the old "Bimi"
//    fixed-reply bot (archived in pagina-estudio) with a real
//    multi-turn WhatsApp chatbot.
// ============================================================
const BSIGN_MENU: FlowTemplate = {
  slug: "bsign_estudio_menu",
  name: "BSign Estudio — Menú principal",
  description:
    "Saluda, muestra el menú de servicios y redirige al sitio web para comprar, agendar cita o ver el estado de un pedido — solo traspasa a un asesor humano si el cliente lo pide.",
  icon: "Building2",
  trigger_type: "keyword",
  trigger_config: {
    keywords: [
      "hola",
      "buenas",
      "buenos días",
      "buenas tardes",
      "buenas noches",
      "menu",
      "menú",
      "ayuda",
      "información",
      "info",
    ],
    match_type: "contains",
    case_sensitive: false,
  } as KeywordTriggerConfig,
  entry_node_id: "start",
  nodes: [
    { node_key: "start", node_type: "start", config: { next_node_key: "welcome" } },
    {
      node_key: "welcome",
      node_type: "send_message",
      config: {
        text: "¡Hola! 👋 Soy el asistente de *BSign Estudio* — diseñamos espacios y creamos objetos en concreto, hechos a mano en Barranquilla. Cuéntame, ¿en qué te ayudo hoy?",
        next_node_key: "main_menu",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "main_menu",
      node_type: "send_list",
      config: {
        text: "Elige una opción y seguimos:",
        button_label: "Ver opciones",
        sections: [
          {
            title: "Nuestros servicios",
            rows: [
              {
                reply_id: "catalogo",
                title: "Ver catálogo",
                description: "Piezas y objetos en concreto",
                next_node_key: "catalogo_msg",
              },
              {
                reply_id: "agendar",
                title: "Agendar cita de diseño",
                description: "Consultoría para tu espacio",
                next_node_key: "agendar_msg",
              },
              {
                reply_id: "proyectos",
                title: "Ver proyectos",
                description: "Conoce nuestro portafolio",
                next_node_key: "proyectos_msg",
              },
              {
                reply_id: "pedido",
                title: "Estado de mi pedido",
                description: "Consulta un pedido existente",
                next_node_key: "pedido_msg",
              },
            ],
          },
          {
            title: "Otros",
            rows: [
              {
                reply_id: "horario",
                title: "Horario y ubicación",
                description: "Cuándo y dónde encontrarnos",
                next_node_key: "horario_msg",
              },
              {
                reply_id: "asesor",
                title: "Hablar con un asesor",
                description: "Te contacta el equipo humano",
                next_node_key: "asesor_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "catalogo_msg",
      node_type: "send_message",
      config: {
        text: "Tenemos piezas de decoración, mobiliario y objetos en concreto hechos a mano 🧱. Puedes ver el catálogo completo aquí: https://bsignestudio.vercel.app/shop\n\nSi tienes dudas de una pieza (tamaños, colores, tiempos de entrega), cuéntame y te ayudo.",
        next_node_key: "anything_else",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "proyectos_msg",
      node_type: "send_message",
      config: {
        text: "Aquí puedes ver algunos de nuestros proyectos de diseño ya entregados: https://bsignestudio.vercel.app/proyectos 🖼️",
        next_node_key: "anything_else",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "horario_msg",
      node_type: "send_message",
      config: {
        text: "Atendemos de lunes a viernes de 9:00 a.m. a 6:00 p.m., y los sábados desde las 10:00 a.m. 📍 Estamos en Barranquilla, y si no puedes venir al estudio también agendamos videollamada por Google Meet.",
        next_node_key: "anything_else",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "pedido_msg",
      node_type: "send_message",
      config: {
        text: "Puedes ver el estado y la línea de tiempo completa de todos tus pedidos aquí: https://bsignestudio.vercel.app/profile/orders 📦\n\nInicia sesión con el mismo correo o WhatsApp de la compra y ahí verás el detalle actualizado al instante.",
        next_node_key: "anything_else",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "agendar_msg",
      node_type: "send_message",
      config: {
        text: "¡Con gusto! Agenda tu cita de diseño directo aquí — eliges el tipo de espacio y el horario que mejor te quede: https://bsignestudio.vercel.app/agendar 📅\n\nToma un par de minutos y queda sujeta a confirmación de nuestro equipo, te avisamos apenas quede lista.",
        next_node_key: "anything_else",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "asesor_handoff",
      node_type: "handoff",
      config: {
        note: "Cliente pidió hablar directamente con un asesor humano desde el menú principal.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "anything_else",
      node_type: "send_buttons",
      config: {
        text: "¿Te ayudo con algo más?",
        buttons: [
          { reply_id: "volver_menu", title: "Ver menú", next_node_key: "main_menu" },
          { reply_id: "terminar", title: "No, gracias", next_node_key: "despedida" },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "despedida",
      node_type: "send_message",
      config: {
        text: "¡Gracias por escribirnos! 🙂 Quedamos atentos por aquí si necesitas algo más. ¡Que tengas un lindo día!",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    { node_key: "end", node_type: "end", config: {} },
  ],
};

// ============================================================
// Registry
// ============================================================

const TEMPLATES: Record<string, FlowTemplate> = {
  welcome_menu: WELCOME_MENU,
  faq_bot: FAQ_BOT,
  lead_capture: LEAD_CAPTURE,
  bsign_estudio_menu: BSIGN_MENU,
};

export function getFlowTemplate(slug: string): FlowTemplate | null {
  return TEMPLATES[slug] ?? null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Object.values(TEMPLATES);
}
