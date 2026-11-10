# Warehouse Setup

https://karpkriss.github.io/Warehouse_Setup_Pages/

Interfejs przeglądarkowy. Mapa pochodzi z prywatnego Supabase po zalogowaniu.

# Panel Zespół

Po zalogowaniu kontem administratora w nagłówku pojawia się Zespół. W tym panelu można wyświetlić konta, nadać rolę Administrator/Edytor/Podgląd i włączyć lub wyłączyć dostęp. Własnego konta nie można tu zmieniać. Uprawnienia obejmują cały Warehouse Setup.

Dodawanie osoby: wpisz e-mail, wybierz rolę i kliknij Utwórz zaproszenie. Skopiuj link i przekaż tej osobie. Wiadomość nie jest wysyłana automatycznie. Link działa 24 godziny i pozwala ustawić własne hasło (minimum 12 znaków). Użytkownik loguje się potem e-mailem i ustawionym hasłem.

Po zmianie uprawnień użytkownik musi zalogować się ponownie. Serwer kontroluje rolę, odmawia zmian nieadministratorowi, zabrania edycji własnego konta i zapisuje operację w dg_audit. Testy DB wykonano na danych syntetycznych w transakcji wycofanej po sprawdzeniu.

To panel kont. Edycje mapy nadal zapisują się lokalnie dla konta. Wspólny zapis, podgląd pracy innych osób i historia zmian mapy wymagają odrębnego rozszerzenia.
