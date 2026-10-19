// Research on mobile is an honest stub for v1: no fake UI, no dead
// buttons. The real research experience lives on the web app.
import * as React from "react";
import { useLang } from "../../lib/i18n";
import { ComingSoon } from "../../lib/components";

export default function Research(): React.JSX.Element {
  const { t, m } = useLang();
  return <ComingSoon title={t.tab_research} body={m("coming_soon_research")} />;
}
