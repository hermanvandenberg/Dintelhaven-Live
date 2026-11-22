# DintelLink-server: de laptop als basisstation

Met deze server werken de Windows-laptop en de iPad met dezelfde planning. De
laptop is het basisstation: daar draait de server, en daar staat de stand. De
iPad opent de app via de laptop en blijft er automatisch mee gelijk.

## Wat je nodig hebt

- **Node.js** op de laptop (de LTS-versie van https://nodejs.org/). Eenmalig
  installeren, met de standaardinstellingen. Voor het AIS-volgen op de laptop
  is **versie 22 of nieuwer** nodig (de huidige LTS is dat).
- Laptop en iPad op **hetzelfde wifi**.

## Eenmalig instellen op de laptop

1. Ga naar https://github.com/hermanvandenberg/Dintelhaven-Live, klik op de groene
   knop **Code** en kies **Download ZIP**.
2. Pak de zip uit naar een vaste plek, bijvoorbeeld `C:\DintelLink`.
3. Open de map `server` en dubbelklik **Installeren.vbs**. Er komt een
   **DintelLink-icoon op het bureaublad**, en de server start voortaan vanzelf
   (onzichtbaar) als je je aanmeldt bij Windows.
4. Windows vraagt de eerste keer of Node.js het netwerk op mag: kies
   **Toestaan** (privé-netwerk). Zonder dit kan de iPad de laptop niet bereiken.

Daarna open je DintelLink altijd met het **icoon op het bureaublad**. Draait de
server nog niet, dan start het icoon hem eerst. Er is geen zwart venster meer.

## De server bedienen

Tik in de app op de laptop **linksonder** op het label. Daar vind je:

- het adres voor de iPad en de **koppelcode**;
- **Automatisch starten met Windows** (aan/uit);
- **Nieuwe versie zoeken**, **Server herstarten** en **Server uitzetten**.

Staat de server uit, dan zet je hem weer aan met het icoon op het bureaublad.
Wat de server meldt, staat in `server-data\server.log`. Werkt er iets niet, start
dan **Start DintelLink-server.bat**: dat is dezelfde server, maar met een
zichtbaar venster waarin je de meldingen meteen ziet.

## Je huidige planning meenemen (eenmalig)

De app via de server is voor de browser een nieuwe plek, en begint dus leeg.
Staat je echte planning nu op de iPad, zet hem dan eerst over naar de laptop:

1. Op de iPad, in de app die je nu gebruikt: **⋯ → Back-up opslaan**. Stuur het
   bestand naar de laptop (OneDrive, mail).
2. Op de laptop (via het icoon): **⋯ → Back-up terugzetten** en kies
   dat bestand. De stand gaat daarna vanzelf naar de server.

## Eenmalig op de iPad

1. Open in Safari het adres uit het servervenster, bijvoorbeeld
   `http://192.168.1.23:8080/`.
2. Vul de **koppelcode** in. Daarna neemt de iPad de planning van de laptop over.
3. Tik op **Deel → Zet op beginscherm**, zodat je hem voortaan zo opent.
   De oude snelkoppeling (GitHub Pages) heeft zijn eigen, losse opslag. Gebruik
   die niet meer naast deze, anders werk je in twee planningen.

Linksonder in de app staat de verbinding: 🟢 verbonden, 🟠 even wachten
(bijvoorbeeld tot de laptop de app geopend heeft), 🔴 geen verbinding.

## Updates

De server kijkt elk kwartier of er op GitHub een nieuwe versie live staat. Is
dat zo, dan haalt hij die op, en in de app verschijnt **Nieuwe versie staat
klaar → Nu laden**. Meteen controleren kan ook: in het serverpaneel op de
laptop (linksonder) met **Nieuwe versie zoeken**. Is de server zelf vernieuwd,
dan start hij vanzelf opnieuw op.

## AIS: de duwboten volgen (Vaarwegen)

De server volgt de duwboten zelf via AISStream, ook als de app op geen enkel
apparaat open staat. Hij gebruikt wat je op **Vaarwegen** invult (boten,
groepen, zones, de AISStream-sleutel), maakt de meldingen ("Bakken zijn
vertrokken", "Duwboot komt eraan") en telt de vaartijd van de groep **Eigen
Boot**. Open je de app, dan zie je alles wat de server ondertussen verzamelde.
Dat staat in `server-data\ais.json`. Zolang de laptop slaapt of uit staat,
wordt er niets gevolgd. Heeft de laptop een oudere Node dan 22, dan volgt de
app zelf zolang hij open staat, zoals voorheen.

## Eigen AIS-ontvanger bij de haven (1.414)

AISStream krijgt zijn posities van ontvangers van vrijwilligers. Rond de haven
zijn er gaten: schepen verspringen of verdwijnen even. Een eigen ontvanger op de
laptop hoort de schepen zelf, elke paar seconden. De server gebruikt dan beide:
wat AISStream stuurt en wat je eigen ontvanger hoort.

**Wat je nodig hebt** (kies één):

1. **Goedkoopst: een USB-radiostickje met AIS-catcher.** Een RTL-SDR-stick
   (bijvoorbeeld RTL-SDR Blog V4, rond de 40 euro) met een marifoon-antenne
   (VHF, 156–162 MHz). Installeer het gratis programma **AIS-catcher** voor
   Windows (https://github.com/jvde-github/AIS-catcher, de "Windows"-download)
   en start het met:

   ```
   AIS-catcher.exe -u 127.0.0.1 10110
   ```

   Zet een snelkoppeling met die regel in de map Opstarten (Windows-toets + R,
   typ `shell:startup`), dan start hij vanzelf met de laptop.
2. **Een kant-en-klare AIS-ontvanger met wifi of netwerk** (rond de 200 tot 350
   euro). Stel hem in om **UDP naar het adres van de laptop, poort 10110** te
   sturen. Of, als de ontvanger zelf een adres heeft (bv. `192.168.4.1:2000`),
   vul dat adres in de app in; de server maakt dan zelf verbinding.

Hoe hoger en vrijer de antenne, hoe beter: buiten, met zicht op de haven en de
laadplaatsen. Binnen achter glas of beton haalt hij veel minder.

**In de app:** Vaarwegen → tegel **AIS-verbinding** → vink **Eigen
AIS-ontvanger bij de haven** aan. Laat het veld leeg voor poort 10110, of vul
een andere poort of het adres van de ontvanger in. Onder het vinkje zie je of
er posities binnenkomen (🟢), of de server nog wacht (🟠) of iets fout ging (🔴).
Het telt alle schepen die de ontvanger hoort, maar de app gebruikt alleen de
boten die op Vaarwegen staan. Een AISStream-sleutel blijft handig voor waar de
eigen ontvanger niet komt; zonder sleutel werkt alleen de eigen ontvanger.

## Goed om te weten

- **De laptop moet aan staan en de server moet draaien** (gaat vanzelf bij het aanmelden). Valt het wifi kort
  weg, dan werkt de iPad gewoon door, en gaan de wijzigingen mee zodra de
  verbinding terug is. Sluit je de app op de iPad terwijl de laptop niet
  bereikbaar is, dan opent hij pas weer als de laptop terug is.
- **Wie wint?** Wijzigen op beide apparaten tegelijk mag. De wijziging die de
  laptop het laatst ontvangt, wint. De planning is één geheel: wijzig je in
  dezelfde seconde op allebei een andere reis, dan blijft er één over.
- **Back-ups:** de server bewaart elk uur een back-up in
  `server-data\back-ups\` (laatste drie dagen). Die zet je terug met
  **⋯ → Back-up terugzetten**.
- **Wat niet meegaat:** thema, pincode-pogingen, weer en ingeklapte panelen
  horen bij het apparaat zelf. AIS-posities, -meldingen en vaartijd komen van
  de server.
- **Ander IP-adres?** Krijgt de laptop van de router een ander adres, kijk dan
  in het servervenster voor het nieuwe. Werkt `http://<naam-van-laptop>.local:8080/`
  op jouw netwerk, gebruik dan dat: dat adres blijft hetzelfde.
- **Gebruikte je eerder het zwarte venster** (*Start DintelLink-server.bat*)?
  Sluit dat venster en dubbelklik daarna één keer **Installeren.vbs**.
