import { createRoot } from "react-dom/client";
import { ChakraProvider, defaultSystem } from "@chakra-ui/react";
import ReceiptLibraryPage from "../app/budgeting/receipts/page";
import ReceiptDetailPage from "../app/budgeting/receipts/[id]/page";
import { AudioPlayer } from "../components/audio-player";
import { usePathname, useSearchParams } from "./opencloud-ui-navigation";

function Fixture() {
  const path = usePathname(), params = useSearchParams();
  return <ChakraProvider value={defaultSystem}><main style={{ maxWidth: 1100, margin: "24px auto", padding: 24 }}>
    {path === "/audio" ? <AudioPlayer label="Synthetic recording" src={`/api/v1/todo-captures/${params.get("capture")}/audio`} />
      : path === "/budgeting/receipts" ? <ReceiptLibraryPage /> : <ReceiptDetailPage />}
  </main></ChakraProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
