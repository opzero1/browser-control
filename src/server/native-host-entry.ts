// Entry of dist/server/native-host.js, the file ensureStableHost copies under the state root. The socket default
// is set first; imports run in this order.
import "./native-host-socket";
import "../native-host/host";
