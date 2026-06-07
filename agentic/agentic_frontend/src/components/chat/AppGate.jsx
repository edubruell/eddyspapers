import Gate from "./Gate.jsx";
import SearchChat from "./SearchChat.jsx";

// Single client island: the password wall wrapping the search app.
export default function AppGate() {
  return (
    <Gate>
      <SearchChat />
    </Gate>
  );
}
