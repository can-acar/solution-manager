# Solution Manager

Rider-inspired Solution Explorer for Visual Studio Code. Solution Manager opens `.sln` and `.slnx` workspaces as a native VS Code tree view with projects, folders, files, dependencies, project actions, and a rich project properties panel.

This project is source-available. You may use Solution Manager to develop both commercial and non-commercial applications, and those applications may be sold or monetized. You may modify Solution Manager itself, but you may not sell, monetize, or distribute Solution Manager, including modified versions, as a paid product.

Important license note: if an earlier release was already distributed under Apache License 2.0, that earlier copy remains under Apache License 2.0. The current license applies to copies distributed with the `LICENSE` file in this repository.

> This extension is not affiliated with Microsoft Visual Studio, JetBrains Rider, or their owners. Product names are used only to describe compatible file formats and familiar workflows.

## English

### Features

- Native Activity Bar view named `Solution`.
- Reads `.sln` and `.slnx` files.
- Lists projects, solution folders, project folders, and files.
- Uses the active VS Code file icon theme for file extension icons.
- Shows a Rider-style dependency tree:
  - Imports
  - Target frameworks such as `.NET 10.0`
  - Assemblies
  - Projects
  - Analyzers
  - Packages
  - Frameworks
  - Source Generators
- Supports project context menu actions:
  - Add C# class, file, folder, or project reference
  - Manage NuGet packages
  - Unload and reload project in the Solution Manager view
  - Entity Framework Core commands
  - Build, restore, clean, rebuild, pack, publish, and test commands
  - Git status, diff, and log scoped to the project folder
  - Copy project path, relative path, project reference XML, or project name
  - Open project in editor, OS file explorer, or integrated terminal
- Supports persistent solution Run Profiles:
  - Select one or more loaded startup projects.
  - Select a `launchSettings.json` Project profile for each startup project.
  - Run projects concurrently in dedicated VS Code Task terminals.
  - Debug projects through the C# Dev Kit `dotnet` debugger.
- Includes a project properties panel with Application, NuGet, Assembly, Build, Inspection, Configuration, Imports, and Diagnostic Properties tabs.

### Requirements

- Visual Studio Code `1.90.0` or newer.
- A workspace containing `.sln`, `.slnx`, or supported project files.
- .NET SDK installed and available on `PATH` for `dotnet` and `dotnet ef` actions.
- Microsoft C# Dev Kit is required for Solution Run Profile debugging.
- Git installed for project-scoped Git actions.

### Usage

1. Install the extension.
2. Open a folder that contains a `.sln` or `.slnx` file.
3. Open the `Solution` view from the Activity Bar.
4. Use Refresh if the solution tree does not appear immediately.
5. Use `Select Run Profile...` from the Solution toolbar or solution context menu to configure startup projects.
6. Use the Solution toolbar Run or Debug actions to start the active profile.
7. Right-click a project to access build, NuGet, Git, EF Core, copy, open, and properties actions.

### Commands

- `Solution Manager: Focus Solution View`
- `Solution Manager: Open Solution File`
- `Solution Manager: Refresh`
- `Solution Manager: Scan Workspace`
- `Solution Manager: Add Project`
- `Solution Manager: Build`
- `Solution Manager: Test`
- `Solution Manager: Select Run Profile...`
- `Solution Manager: Run Active Profile`
- `Solution Manager: Debug Active Profile`

### Project Properties

The `Properties...` action opens a readonly webview panel. It displays project metadata parsed from the project file, including target frameworks, root namespace, assembly name, package references, project references, framework references, analyzers, imports, and diagnostic properties.

### Packaging

```bash
npx @vscode/vsce package --no-dependencies --skip-license
```

### Current Limitations

- Project unload/reload is view state only; it does not modify the `.sln` or `.slnx` file.
- NuGet management currently uses QuickPick prompts and `dotnet` terminal commands.
- Some project properties, such as signing and build events, are shown as configuration tabs but may be empty unless parser support is added for those fields.

### License

Licensed under the Solution Manager Source-Available License. See the `LICENSE` file in this repository.

In short, you may use Solution Manager as a development tool for commercial and non-commercial applications. Those applications are not restricted by this license merely because they were created with Solution Manager. You may also modify Solution Manager, but you may not sell, monetize, repackage, or distribute Solution Manager itself as a paid product, paid extension, paid subscription feature, paid hosted service, or paid bundle.

If you previously published a release under Apache License 2.0, that already-published copy keeps the Apache License 2.0 permissions. Apache License 2.0 grants broad rights to reproduce, prepare derivative works, distribute, sublicense, and, under its patent grant, sell the work. The source-available license in this repository should be used for current and future copies where you want to keep application development allowed while preventing sale of Solution Manager itself.

Allowed:

- Use Solution Manager to develop commercial or non-commercial applications.
- Sell, license, host, or otherwise commercialize applications created with Solution Manager.
- Study, modify, and improve Solution Manager.
- Share original or modified copies of Solution Manager for free, as long as the license terms are preserved.

Not allowed:

- Sell Solution Manager itself.
- Sell modified versions of Solution Manager.
- Offer Solution Manager as a paid extension, paid plugin, paid subscription feature, paid hosted service, or paid bundle.
- Remove or hide the license and copyright notices.

## Türkçe

Bu proje source-available olarak sunulur. Solution Manager kullanarak ticari veya ticari olmayan uygulamalar geliştirebilirsiniz ve bu uygulamaları satabilir ya da ticarileştirebilirsiniz. Solution Manager üzerinde geliştirme yapabilirsiniz, ancak Solution Manager'ın kendisini, değiştirilmiş sürümleri dahil, satamaz, paraya çeviremez veya ücretli ürün olarak dağıtamazsınız.

Önemli lisans notu: daha önce Apache License 2.0 ile dağıtılmış bir sürüm varsa, o eski kopya Apache License 2.0 altında kalır. Bu repodaki `LICENSE` dosyasıyla dağıtılan mevcut kopyalar için yeni lisans geçerlidir.

### Özellikler

- Activity Bar içinde native `Solution` görünümü.
- `.sln` ve `.slnx` dosyalarını okur.
- Projeleri, solution folder yapılarını, proje klasörlerini ve dosyaları listeler.
- Dosya uzantıları için aktif VS Code file icon theme ikonlarını kullanır.
- Rider benzeri dependency ağacı gösterir:
  - Imports
  - `.NET 10.0` gibi target framework düğümleri
  - Assemblies
  - Projects
  - Analyzers
  - Packages
  - Frameworks
  - Source Generators
- Proje sağ tık menüsüyle şu işlemleri destekler:
  - C# class, dosya, klasör veya project reference ekleme
  - NuGet paketlerini yönetme
  - Projeyi Solution Manager görünümünde unload/reload yapma
  - Entity Framework Core komutları
  - Build, restore, clean, rebuild, pack, publish ve test komutları
  - Proje klasörü kapsamında Git status, diff ve log
  - Project path, relative path, project reference XML veya proje adını kopyalama
  - Projeyi editor, OS dosya gezgini veya integrated terminal içinde açma
- Application, NuGet, Assembly, Build, Inspection, Configuration, Imports ve Diagnostic Properties sekmelerine sahip project properties paneli içerir.

### Gereksinimler

- Visual Studio Code `1.90.0` veya üzeri.
- `.sln`, `.slnx` veya desteklenen project dosyaları içeren bir workspace.
- `dotnet` ve `dotnet ef` işlemleri için .NET SDK'nın `PATH` üzerinde erişilebilir olması.
- Proje kapsamlı Git işlemleri için Git kurulumu.

### Kullanım

1. Extension'ı yükleyin.
2. `.sln` veya `.slnx` içeren bir klasörü VS Code ile açın.
3. Activity Bar üzerinden `Solution` görünümünü açın.
4. Ağaç hemen gelmezse Refresh kullanın.
5. Bir projeye sağ tıklayarak build, NuGet, Git, EF Core, copy, open ve properties işlemlerine erişin.

### Komutlar

- `Solution Manager: Focus Solution View`
- `Solution Manager: Open Solution File`
- `Solution Manager: Refresh`
- `Solution Manager: Scan Workspace`
- `Solution Manager: Add Project`
- `Solution Manager: Build`
- `Solution Manager: Test`

### Project Properties

`Properties...` işlemi readonly bir webview paneli açar. Panel project dosyasından okunan target framework, root namespace, assembly name, package references, project references, framework references, analyzers, imports ve diagnostic properties bilgilerini gösterir.

### Paketleme

```bash
npx @vscode/vsce package --no-dependencies --skip-license
```

### Mevcut Sınırlar

- Project unload/reload sadece Solution Manager görünüm state'idir; `.sln` veya `.slnx` dosyasını değiştirmez.
- NuGet yönetimi şu an QuickPick ve `dotnet` terminal komutlarıyla yapılır.
- Signing ve build events gibi bazı project properties sekmeleri görünür, ancak ilgili alanlar için parser desteği eklenmediyse boş veya `Not configured` görünebilir.

### Lisans

Solution Manager Source-Available License ile lisanslanmıştır. Detaylar için repodaki `LICENSE` dosyasına bakın.

Kısaca Solution Manager'ı ticari veya ticari olmayan uygulamalar geliştirmek için kullanabilirsiniz. Bu lisans, yalnızca Solution Manager ile geliştirildiği için uygulamalarınıza ek kısıtlama getirmez. Solution Manager üzerinde değişiklik yapabilirsiniz; ancak Solution Manager'ın kendisini satamaz, paraya çeviremez, yeniden paketleyip ücretli ürün/extension/abonelik özelliği/barındırılan servis/ücretli bundle olarak dağıtamazsınız.

Daha önce Apache License 2.0 ile bir sürüm yayınladıysanız, o yayınlanmış kopya Apache License 2.0 izinlerini korur. Apache License 2.0; çoğaltma, türev çalışma hazırlama, dağıtma, alt lisanslama ve patent izni kapsamında satma gibi geniş haklar verir. Bu repodaki source-available lisansı, mevcut ve sonraki kopyalarda uygulama geliştirmeyi serbest bırakıp Solution Manager ürününün kendisinin satılmasını engellemek istediğiniz durum için kullanılmalıdır.

İzin verilenler:

- Solution Manager ile ticari veya ticari olmayan uygulamalar geliştirmek.
- Solution Manager ile geliştirilen uygulamaları satmak, lisanslamak, barındırmak veya ticarileştirmek.
- Solution Manager'ı incelemek, değiştirmek ve geliştirmek.
- Lisans şartları korunduğu sürece Solution Manager'ın orijinal veya değiştirilmiş kopyalarını ücretsiz paylaşmak.

İzin verilmeyenler:

- Solution Manager'ın kendisini satmak.
- Solution Manager'ın değiştirilmiş sürümlerini satmak.
- Solution Manager'ı ücretli extension, ücretli plugin, abonelik özelliği, barındırılan servis veya ücretli bundle olarak sunmak.
- Lisans ve telif bildirimlerini kaldırmak veya gizlemek.
