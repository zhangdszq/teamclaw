import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { QuickWindow } from './components/QuickWindow.tsx'
import { initAnalytics, setAnalyticsContext, viewTrack } from './lib/analytics'

const isQuick = new URLSearchParams(window.location.search).get('mode') === 'quick'

if (isQuick) {
	document.documentElement.style.background = 'transparent'
	document.body.style.background = 'transparent'
}

initAnalytics()
setAnalyticsContext({
	window_name: isQuick ? 'quick_window' : 'main_window',
	source_type: 'ui',
	source_channel: isQuick ? 'quick_window' : 'main_window',
})

if (!isQuick) {
	viewTrack('main_window_page_view', {
		page_id: 'main_window',
		window_name: 'main_window',
		source_type: 'ui',
		source_channel: 'main_window',
	})
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		{isQuick ? <QuickWindow /> : <App />}
	</StrictMode>
)

