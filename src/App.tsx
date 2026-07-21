import { FloorplanProvider } from './state/FloorplanContext';
import { AppShell } from './components/layout/AppShell';

export default function App() {
  return (
    <FloorplanProvider>
      <AppShell />
    </FloorplanProvider>
  );
}
