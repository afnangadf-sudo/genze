import * as React from "react";
import { useLang } from "../../lib/i18n";
import { ComingSoon } from "../../lib/components";

export default function Write(): React.JSX.Element {
  const { t, m } = useLang();
  return <ComingSoon title={t.tab_write} body={m("coming_soon_write")} />;
}
