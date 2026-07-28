# NoteFlow

Une petite app de prise de notes (PWA) : texte mis en forme + dessin libre par note, sans backend, 100% hors-ligne.

## Fonctionnalités

- Liste de notes avec recherche et dossiers (étiquettes colorées)
- Éditeur de texte enrichi (gras, italique, souligné, titre, liste à puces, liste à cocher)
- Zone de dessin libre par note (souris, trackpad ou doigt), avec couleurs, épaisseurs, gomme, annuler et tout effacer
- Notes épinglées en haut de liste
- Sauvegarde automatique dans IndexedDB (rien n'est envoyé à un serveur)
- Installable sur iPhone, Mac et Windows comme une vraie app

## Utiliser en local

```bash
cd noteflow
python3 -m http.server 8080
```

Puis ouvrir `http://localhost:8080`.

## Installer

- **iPhone** : Safari → Partager → "Sur l'écran d'accueil"
- **Mac** : Safari → Fichier → "Ajouter au Dock" (ou glisser l'icône de l'onglet vers le Dock)
- **Windows** : Chrome/Edge → icône d'installation dans la barre d'adresse
