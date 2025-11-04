import { useState } from 'react';

export default function App() {
  const [status, setStatus] = useState('unknown');

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>BTC Stablecoin on ICP</h1>
      <p>Monorepo scaffold is ready.</p>
      <p>
        Backend health: <strong>{status}</strong>
      </p>
      <button onClick={() => setStatus('ok')}>Mock Check</button>
    </div>
  );
}

