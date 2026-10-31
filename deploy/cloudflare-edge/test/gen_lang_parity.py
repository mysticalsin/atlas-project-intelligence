"""Record Python atlas_voice/languages.py detect() on a table of texts for the JS port (test/lang-detect.test.js)."""
import json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]; sys.path.insert(0, str(ROOT))
from atlas_voice.languages import detect

TEXTS = [
    # one clear sentence per language (the 20 of the brief, then a few more scripts)
    'We moved the claims platform to the cloud last year and the team was happy with it', 'Nous avons réduit le délai de traitement de quarante à douze minutes',
    'Reducimos el tiempo de clasificación a doce minutos y el equipo quedó contento', 'Nós reduzimos o tempo de triagem de quarenta para doze minutos',
    'Wir haben die Bearbeitungszeit von vierzig auf zwölf Minuten reduziert', 'Abbiamo ridotto il tempo di smistamento da quaranta a dodici minuti',
    'We hebben de doorlooptijd van veertig naar twaalf minuten teruggebracht', 'Skróciliśmy czas obsługi z czterdziestu do dwunastu minut i zespół był zadowolony',
    'Am redus timpul de procesare de la patruzeci la douăsprezece minute și echipa a fost foarte mulțumită de noua platformă', 'قللنا وقت المعالجة من أربعين إلى اثنتي عشرة دقيقة', '我们把处理时间从四十分钟缩短到十二分钟',
    '処理時間を40分から12分に短縮しました', '처리 시간을 40분에서 12분으로 줄였습니다', 'हमने प्रसंस्करण का समय चालीस मिनट से घटाकर बारह मिनट कर दिया',
    'Мы сократили время обработки с сорока до двенадцати минут', 'İşlem süresini kırk dakikadan on iki dakikaya düşürdük ve ekip çok memnun kaldı',
    'Vi minskade handläggningstiden från fyrtio till tolv minuter och teamet var nöjt', 'Vi reducerede sagsbehandlingstiden fra fyrre til tolv minutter og holdet var glad',
    'Vi reduserte saksbehandlingstiden fra førti til tolv minutter og teamet var fornøyd', 'Lyhensimme käsittelyaikaa neljästäkymmenestä kahteentoista minuuttiin ja tiimi oli tyytyväinen',
    'Скоротили час обробки з сорока до дванадцяти хвилин і команда була задоволена', 'Σμικρύναμε τον χρόνο επεξεργασίας από σαράντα σε δώδεκα λεπτά', 'קיצרנו את זמן הטיפול מארבעים לשתים עשרה דקות',
    'เราลดเวลาประมวลผลจากสี่สิบนาทีเหลือสิบสองนาที', 'আমরা প্রক্রিয়াকরণের সময় চল্লিশ মিনিট থেকে কমিয়ে বারো মিনিট করেছি', 'செயலாக்க நேரத்தை நாற்பது நிமிடங்களிலிருந்து பன்னிரண்டு நிமிடங்களாக குறைத்தோம்',
    'ما زمان پردازش را از چهل دقیقه به دوازده دقیقه کاهش دادیم چون گروه ما خیلی خوب کار کرد', 'ہم نے پروسیسنگ کا وقت چالیس منٹ سے کم کر کے بارہ منٹ کر دیا ہے ٹھیک',
    # short, thin, mixed and degenerate texts
    'Oui', 'ok thanks', 'yes', 'Sí, claro', 'Je pense que le client était content mais the platform was great', 'we used Kafka and Terraform', 'Kafka', '', '   ', None, '12345', '40 → 12 min', '😀😀😀',
    'I think the client, enfin le client, was happy with the migration and the whole team', 'Das Projekt war ein Erfolg, aber the sponsor left halfway through', 'a', 'I', 'an',
    'Das war einfach großartig und wir haben es sehr gut gemacht', 'The quick brown fox jumps over the lazy dog and the team was happy with it', 'ça va très bien et nous sommes contents',
    'Quand nous avons commencé, personne ne savait où étaient les données ni qui les possédait', 'Cuando empezamos nadie sabía dónde estaban los datos ni quién era el dueño',
    'Quando começamos ninguém sabia onde estavam os dados nem quem era o responsável', 'Als wir anfingen, wusste niemand, wo die Daten waren oder wem sie gehörten',
    'Quando abbiamo iniziato nessuno sapeva dove fossero i dati né a chi appartenessero', 'Toen we begonnen wist niemand waar de gegevens waren of van wie ze waren',
    'Kiedy zaczynaliśmy nikt nie wiedział gdzie są dane ani do kogo należą', 'Când am început nimeni nu știa unde sunt datele sau cui aparțin', 'Başladığımızda kimse verilerin nerede olduğunu bilmiyordu',
    'När vi började visste ingen var datan fanns eller vem som ägde den', 'Da vi begyndte vidste ingen hvor dataene var eller hvem der ejede dem', 'Da vi begynte visste ingen hvor dataene var eller hvem som eide dem',
    'Kun aloitimme kukaan ei tiennyt missä tiedot olivat tai kuka omisti ne', 'Когда мы начинали, никто не знал, где находятся данные и кому они принадлежат',
    'Коли ми починали, ніхто не знав, де знаходяться дані і кому вони належать', 'ひらがなとカタカナと漢字が混ざった文章です', 'カタカナだけのテスト', '漢字だけ', '这是一个测试。我们提高了效率。', '안녕하세요',
    'Meeting at 10:30 with Zoë Ålund about énergie', 'Project Alpha-7 went live on 2025-03-14', 'Hello こんにちは bonjour', 'Привет, hello', 'ok ok ok ok ok ok',
    'こんにちは、プロジェクトについてお話しします', 'mixed العربية and English words together in one sentence here', 'the the the the', 'de la de la de la de la', 'ich bin ich bin ich bin',
    'x' * 900, 'we ' * 400 + 'nous', 'Æbler og øl og æg er godt', 'Ñandú ñoño año', 'Işık ığ ş gün', 'Łódź żółć gęś', 'Țară și românește',
]
out = [[[t], detect(t)] for t in TEXTS]
(Path(__file__).parent / 'lang.vectors.json').write_text(json.dumps(out, ensure_ascii=False))
print(len(out))
