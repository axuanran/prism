import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";
import { router } from "./router";
import DecisionTableEditor from "./editors/DecisionTableEditor.vue";
import ExpressionEditor from "./editors/ExpressionEditor.vue";
import { registerEditor } from "./editors/registry";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "./styles/tokens.css";
import "./styles/main.css";

registerEditor("prism.expression", ExpressionEditor);
registerEditor("prism.decision-table", DecisionTableEditor);

createApp(App).use(createPinia()).use(router).mount("#app");
