// Einstellungen der Karte. Jede lässt sich auch per URL-Parameter überschreiben,
// z. B. index.html?laender=1&fps=20&versatz=-0.15
window.ZUGKARTE = {
  // Adresse der Echtzeit-Verspätungen (Vercel-Funktion). Leer = nur Fahrplan.
  delaysUrl: "https://fantastic-telegram-35tn.vercel.app/api/delays",
  fps: 30,           // Bilder pro Sekunde
  laender: false,    // Bundesländergrenzen zeigen
  grenze: 1.8,       // Strichstärke der Landesgrenzen
  versatz: 0,        // Karte seitlich verschieben (-0.3 … 0.3 Bildschirmbreiten), z. B. für Desktop-Icons
  helligkeit: 1,     // Leuchtstärke der Züge
};
