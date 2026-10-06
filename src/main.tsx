import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import PddApp from './PddApp';
import { preloadBarcodeReader } from './pdd-barcode-reader';
import './pdd.css';
// Warm the local decoder on page open without blocking the page or asking for camera access.
// The scanner reports a failed load when opened; manual queries stay available.
void preloadBarcodeReader().catch(() => undefined);
if (!document.querySelector('link[rel="icon"]')) {
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"%3E%3Crect width="64" height="64" rx="14" fill="%23674782"/%3E%3Ctext x="32" y="41" text-anchor="middle" font-family="sans-serif" font-size="27" font-weight="700" fill="white"%3E404%3C/text%3E%3C/svg%3E';
    document.head.appendChild(icon);
}
ReactDOM.createRoot(document.getElementById('root')!).render(<BrowserRouter><PddApp /></BrowserRouter>);
