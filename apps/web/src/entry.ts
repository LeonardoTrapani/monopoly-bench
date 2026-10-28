import { Runtime } from "foldkit";

import { ApiLive } from "./api/layer.ts";
import { flags, init } from "./init.ts";
import { Message } from "./message.ts";
import { Flags, Model } from "./model.ts";
import { subscriptions } from "./subscription.ts";
import { update } from "./update.ts";
import { view } from "./view.ts";

const application = Runtime.makeApplication({
  Model,
  Flags,
  init,
  update,
  view,
  subscriptions,
  resources: ApiLive,
  container: document.getElementById("root"),
  routing: {
    onUrlRequest: (request) => Message.ClickedLink({ request }),
    onUrlChange: (url) => Message.ChangedUrl({ url }),
  },
});

Runtime.run(application, { flags });
