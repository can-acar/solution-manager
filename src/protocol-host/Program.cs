using System.Text.Json;
using System.Text.Json.Serialization;
using NuGet.Common;
using NuGet.Configuration;
using NuGet.Frameworks;
using NuGet.Packaging;
using NuGet.Protocol;
using NuGet.Protocol.Core.Types;
using NuGet.Versioning;

var input = await Console.In.ReadToEndAsync();
var options = JsonOptions.Create();

try
{
    var request = JsonSerializer.Deserialize<ProtocolRequest>(input, options)
        ?? throw new InvalidOperationException("Request body is empty.");

    var host = new ProtocolHost(request);
    var data = request.Command switch
    {
        "list-sources" => (object)await host.ListSourcesAsync(),
        "search" => (object)await host.SearchAsync(),
        "get-package" => (object)await host.GetPackageAsync(),
        "get-package-details" => (object)await host.GetPackageDetailsAsync(),
        _ => throw new InvalidOperationException($"Unknown protocol command '{request.Command}'.")
    };

    WriteJson(new ProtocolResponse<object>(false, data, null), options);
}
catch (Exception ex)
{
    WriteJson(
        new ProtocolResponse<object>(true, null, new ProtocolError(ex.Message)),
        options);
}

static void WriteJson(object value, JsonSerializerOptions options)
{
    Console.Out.Write(JsonSerializer.Serialize(value, options));
}

internal sealed class ProtocolHost
{
    private readonly ProtocolRequest _request;
    private readonly ILogger _logger = NullLogger.Instance;
    private readonly CancellationToken _cancellationToken = CancellationToken.None;

    public ProtocolHost(ProtocolRequest request)
    {
        _request = request;
    }

    public Task<List<SourceDto>> ListSourcesAsync()
    {
        var sources = LoadPackageSources()
            .Where(x => x.IsEnabled)
            .GroupBy(x => NormalizeSource(x.Source), StringComparer.OrdinalIgnoreCase)
            .Select(x => x.First())
            .Select(x => new SourceDto(
                x.Name,
                NormalizeSourceForDisplay(x.Source),
                true,
                "nuget-config"))
            .ToList();

        return Task.FromResult(sources);
    }

    public async Task<List<PackageDto>> SearchAsync()
    {
        var source = ResolveSource();
        if (TryGetLocalPath(source.Source, out var localPath))
        {
            return SearchLocalPackages(localPath);
        }

        using var cache = new SourceCacheContext();
        var repository = Repository.Factory.GetCoreV3(source);
        var resource = await repository.GetResourceAsync<PackageSearchResource>(_cancellationToken);
        var filter = new SearchFilter(includePrerelease: _request.Prerelease);
        var results = await resource.SearchAsync(
            _request.Filter ?? string.Empty,
            filter,
            Math.Max(_request.Skip, 0),
            Math.Max(_request.Take, 1),
            _logger,
            _cancellationToken);

        return results
            .Select(item => MapPackage(item, new[] { item }))
            .ToList();
    }

    public async Task<PackageDto> GetPackageAsync()
    {
        var packageId = Required(_request.PackageId, "PackageId");
        var source = ResolveSource();
        if (TryGetLocalPath(source.Source, out var localPath))
        {
            return GetLocalPackage(localPath, packageId);
        }

        var repository = Repository.Factory.GetCoreV3(source);
        var package = await GetPackageFromMetadataAsync(repository, packageId);
        return package ?? throw new InvalidOperationException($"Package '{packageId}' could not be found.");
    }

    public async Task<PackageDetailsDto> GetPackageDetailsAsync()
    {
        var packageId = Required(_request.PackageId, "PackageId");
        var version = Required(_request.Version, "Version");
        var source = ResolveSource();
        if (TryGetLocalPath(source.Source, out var localPath))
        {
            return GetLocalPackageDetails(localPath, packageId, version);
        }

        using var cache = new SourceCacheContext();
        var repository = Repository.Factory.GetCoreV3(source);
        var resource = await repository.GetResourceAsync<PackageMetadataResource>(_cancellationToken);
        var metadata = await resource.GetMetadataAsync(
            packageId,
            includePrerelease: true,
            includeUnlisted: false,
            cache,
            _logger,
            _cancellationToken);

        var requestedVersion = NuGetVersion.Parse(version);
        var selected = metadata
            .Where(x => x.Identity.Version == requestedVersion)
            .OrderBy(x => x.Identity.Version)
            .LastOrDefault();

        if (selected == null)
        {
            return PackageDetailsDto.Empty();
        }

        return MapDependencies(selected.DependencySets);
    }

    private async Task<PackageDto?> GetPackageFromMetadataAsync(
        SourceRepository repository,
        string packageId)
    {
        using var cache = new SourceCacheContext();
        var resource = await repository.GetResourceAsync<PackageMetadataResource>(_cancellationToken);
        var metadata = await resource.GetMetadataAsync(
            packageId,
            includePrerelease: _request.Prerelease,
            includeUnlisted: false,
            cache,
            _logger,
            _cancellationToken);

        var versions = metadata
            .Where(x => _request.Prerelease || !x.Identity.Version.IsPrerelease)
            .OrderBy(x => x.Identity.Version)
            .ToList();

        var latest = versions.LastOrDefault();
        return latest == null ? null : await MapPackageAsync(repository, latest, versions);
    }

    private List<PackageDto> SearchLocalPackages(string localPath)
    {
        var filter = (_request.Filter ?? string.Empty).Trim();
        var packages = ReadLocalPackages(localPath)
            .Where(x => _request.Prerelease || !x.Version.IsPrerelease)
            .Where(x =>
                string.IsNullOrWhiteSpace(filter)
                || x.Id.Contains(filter, StringComparison.OrdinalIgnoreCase)
                || x.Description.Contains(filter, StringComparison.OrdinalIgnoreCase)
                || x.Tags.Any(t => t.Contains(filter, StringComparison.OrdinalIgnoreCase)))
            .GroupBy(x => x.Id, StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x.Key)
            .Skip(Math.Max(_request.Skip, 0))
            .Take(Math.Max(_request.Take, 1))
            .Select(group =>
            {
                var ordered = group.OrderBy(x => x.Version).ToList();
                var latest = ordered.Last();
                return latest.ToPackage(ordered.Select(x => x.Version));
            })
            .ToList();

        return packages;
    }

    private PackageDto GetLocalPackage(string localPath, string packageId)
    {
        var versions = ReadLocalPackages(localPath)
            .Where(x => string.Equals(x.Id, packageId, StringComparison.OrdinalIgnoreCase))
            .Where(x => _request.Prerelease || !x.Version.IsPrerelease)
            .OrderBy(x => x.Version)
            .ToList();

        if (versions.Count == 0)
        {
            throw new InvalidOperationException($"Package '{packageId}' could not be found in '{localPath}'.");
        }

        return versions.Last().ToPackage(versions.Select(x => x.Version));
    }

    private PackageDetailsDto GetLocalPackageDetails(string localPath, string packageId, string version)
    {
        var requestedVersion = NuGetVersion.Parse(version);
        var selected = ReadLocalPackages(localPath)
            .FirstOrDefault(x =>
                string.Equals(x.Id, packageId, StringComparison.OrdinalIgnoreCase)
                && x.Version == requestedVersion);

        return selected == null
            ? PackageDetailsDto.Empty()
            : MapDependencies(selected.DependencyGroups);
    }

    private List<LocalPackageInfo> ReadLocalPackages(string localPath)
    {
        if (!Directory.Exists(localPath))
        {
            throw new DirectoryNotFoundException($"Local NuGet source '{localPath}' does not exist.");
        }

        var packages = new List<LocalPackageInfo>();
        foreach (var file in Directory.EnumerateFiles(localPath, "*.nupkg", SearchOption.AllDirectories))
        {
            try
            {
                using var stream = File.OpenRead(file);
                using var reader = new PackageArchiveReader(stream);
                var nuspec = reader.NuspecReader;
                var version = nuspec.GetVersion();
                if (version == null) continue;

                packages.Add(new LocalPackageInfo(
                    nuspec.GetId(),
                    version,
                    SplitValues(nuspec.GetAuthors()).ToList(),
                    nuspec.GetDescription() ?? string.Empty,
                    ReadPackageIcon(reader, nuspec),
                    nuspec.GetLicenseUrl() ?? string.Empty,
                    nuspec.GetProjectUrl() ?? string.Empty,
                    SplitValues(nuspec.GetTags()).ToList(),
                    nuspec.GetDependencyGroups().ToList(),
                    file));
            }
            catch
            {
                // Ignore malformed package files so one bad local package does not break the whole source.
            }
        }

        return packages;
    }

    private PackageSource ResolveSource()
    {
        var sourceUrl = Required(_request.SourceUrl, "SourceUrl");
        var normalized = NormalizeSource(sourceUrl);
        var configured = LoadPackageSources()
            .FirstOrDefault(x =>
                string.Equals(NormalizeSource(x.Source), normalized, StringComparison.OrdinalIgnoreCase)
                || string.Equals(x.Name, _request.SourceName, StringComparison.OrdinalIgnoreCase));

        if (configured != null)
        {
            return configured;
        }

        return new PackageSource(
            NormalizeSourceForProtocol(sourceUrl),
            _request.SourceName ?? sourceUrl);
    }

    private List<PackageSource> LoadPackageSources()
    {
        var roots = (_request.WorkspaceFolders?.Length ?? 0) > 0
            ? _request.WorkspaceFolders!
            : new[] { Directory.GetCurrentDirectory() };

        var sources = new List<PackageSource>();
        foreach (var root in roots)
        {
            sources.AddRange(LoadPackageSources(root));
        }

        sources.AddRange(LoadPackageSources(null));
        return sources
            .GroupBy(x => $"{x.Name}|{NormalizeSource(x.Source)}", StringComparer.OrdinalIgnoreCase)
            .Select(x => x.First())
            .ToList();
    }

    private static IEnumerable<PackageSource> LoadPackageSources(string? root)
    {
        try
        {
            var settings = Settings.LoadDefaultSettings(root);
            var provider = new PackageSourceProvider(settings);
            return provider.LoadPackageSources();
        }
        catch
        {
            return Array.Empty<PackageSource>();
        }
    }

    private async Task<PackageDto> MapPackageAsync(
        SourceRepository repository,
        IPackageSearchMetadata latest,
        IReadOnlyCollection<IPackageSearchMetadata> versions)
    {
        var iconUrl = latest.IconUrl?.ToString() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(iconUrl))
        {
            iconUrl = await TryReadRemoteEmbeddedIconAsync(
                repository,
                latest.Identity.Id,
                latest.Identity.Version);
        }

        return MapPackage(latest, versions, iconUrl);
    }

    private async Task<string> TryReadRemoteEmbeddedIconAsync(
        SourceRepository repository,
        string packageId,
        NuGetVersion version)
    {
        try
        {
            using var cache = new SourceCacheContext();
            var resource = await repository.GetResourceAsync<FindPackageByIdResource>(_cancellationToken);
            await using var stream = new MemoryStream();
            var copied = await resource.CopyNupkgToStreamAsync(
                packageId,
                version,
                stream,
                cache,
                _logger,
                _cancellationToken);

            if (!copied)
            {
                return string.Empty;
            }

            stream.Position = 0;
            using var reader = new PackageArchiveReader(stream);
            return ReadEmbeddedIcon(reader, reader.NuspecReader);
        }
        catch
        {
            return string.Empty;
        }
    }

    private static string ReadPackageIcon(PackageArchiveReader reader, NuspecReader nuspec)
    {
        var iconUrl = nuspec.GetIconUrl();
        return string.IsNullOrWhiteSpace(iconUrl)
            ? ReadEmbeddedIcon(reader, nuspec)
            : iconUrl;
    }

    private static string ReadEmbeddedIcon(PackageArchiveReader reader, NuspecReader nuspec)
    {
        var iconPath = nuspec.GetIcon();
        if (string.IsNullOrWhiteSpace(iconPath))
        {
            return string.Empty;
        }

        var normalizedIconPath = NormalizePackagePath(iconPath);
        var packageFile = reader.GetFiles()
            .FirstOrDefault(x =>
                string.Equals(
                    NormalizePackagePath(x),
                    normalizedIconPath,
                    StringComparison.OrdinalIgnoreCase));

        if (packageFile == null)
        {
            return string.Empty;
        }

        using var iconStream = reader.GetStream(packageFile);
        using var buffer = new MemoryStream();
        iconStream.CopyTo(buffer);
        if (buffer.Length == 0 || buffer.Length > 1024 * 1024)
        {
            return string.Empty;
        }

        return $"data:{GetIconContentType(packageFile)};base64,{Convert.ToBase64String(buffer.ToArray())}";
    }

    private static string NormalizePackagePath(string path)
    {
        return path.Replace('\\', '/').TrimStart('/');
    }

    private static string GetIconContentType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".svg" => "image/svg+xml",
            ".gif" => "image/gif",
            ".ico" => "image/x-icon",
            _ => "application/octet-stream"
        };
    }

    private static PackageDto MapPackage(
        IPackageSearchMetadata latest,
        IReadOnlyCollection<IPackageSearchMetadata> versions,
        string? iconUrlOverride = null)
    {
        return new PackageDto
        {
            Id = latest.Identity.Id,
            Name = latest.Identity.Id,
            Authors = SplitValues(latest.Authors).ToList(),
            Description = latest.Description ?? latest.Summary ?? string.Empty,
            IconUrl = iconUrlOverride ?? latest.IconUrl?.ToString() ?? string.Empty,
            LicenseUrl = latest.LicenseUrl?.ToString() ?? string.Empty,
            ProjectUrl = latest.ProjectUrl?.ToString() ?? string.Empty,
            Registration = string.Empty,
            TotalDownloads = latest.DownloadCount ?? 0,
            Verified = latest.PrefixReserved,
            Version = FormatVersion(latest.Identity.Version),
            Versions = versions
                .OrderBy(x => x.Identity.Version)
                .Select(x => new PackageVersionDto(
                    FormatVersion(x.Identity.Version),
                    FormatVersion(x.Identity.Version)))
                .ToList(),
            Tags = SplitValues(latest.Tags).ToList()
        };
    }

    private static PackageDetailsDto MapDependencies(IEnumerable<PackageDependencyGroup> dependencyGroups)
    {
        var frameworks = new Dictionary<string, List<PackageDependencyDto>>(StringComparer.OrdinalIgnoreCase);
        foreach (var group in dependencyGroups)
        {
            var dependencies = group.Packages
                .Select(x => new PackageDependencyDto(x.Id, x.VersionRange?.OriginalString ?? string.Empty))
                .ToList();
            if (dependencies.Count == 0) continue;

            frameworks[GetFrameworkName(group.TargetFramework)] = dependencies;
        }

        return new PackageDetailsDto(new PackageDependencyGroupDto(frameworks));
    }

    private static string GetFrameworkName(NuGetFramework? framework)
    {
        if (framework == null || framework == NuGetFramework.AnyFramework)
        {
            return "Any";
        }

        return framework.GetShortFolderName();
    }

    private static bool TryGetLocalPath(string source, out string localPath)
    {
        source = NormalizeSourceForProtocol(source);
        if (Uri.TryCreate(source, UriKind.Absolute, out var uri) && uri.IsFile)
        {
            localPath = uri.LocalPath;
            return true;
        }

        if (!Uri.TryCreate(source, UriKind.Absolute, out _))
        {
            localPath = source;
            return true;
        }

        localPath = string.Empty;
        return false;
    }

    private static string NormalizeSource(string source)
    {
        return NormalizeSourceForProtocol(source).TrimEnd('/', '\\');
    }

    private static string NormalizeSourceForDisplay(string source)
    {
        if (TryGetLocalPath(source, out var localPath))
        {
            return localPath;
        }

        return source;
    }

    private static string NormalizeSourceForProtocol(string source)
    {
        if (source.StartsWith("~/", StringComparison.Ordinal))
        {
            return Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                source[2..]);
        }

        return source;
    }

    private static IEnumerable<string> SplitValues(string? value)
    {
        return (value ?? string.Empty)
            .Split(new[] { ',', ';' }, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    private static string FormatVersion(NuGetVersion version)
    {
        return version.ToNormalizedString();
    }

    private static string Required(string? value, string name)
    {
        return string.IsNullOrWhiteSpace(value)
            ? throw new InvalidOperationException($"{name} is required.")
            : value;
    }
}

internal sealed record ProtocolRequest
{
    public string Command { get; init; } = string.Empty;
    public string? SourceName { get; init; }
    public string? SourceUrl { get; init; }
    public string? PackageId { get; init; }
    public string? Version { get; init; }
    public string? Filter { get; init; }
    public bool Prerelease { get; init; } = true;
    public int Skip { get; init; }
    public int Take { get; init; } = 100;
    public string[]? WorkspaceFolders { get; init; }
}

internal sealed record ProtocolResponse<T>(bool IsFailure, T? Data, ProtocolError? Error);
internal sealed record ProtocolError(string Message);
internal sealed record SourceDto(string Name, string Url, bool IsReadOnly, string Origin);
internal sealed record PackageVersionDto(string Version, string Id);
internal sealed record PackageDependencyDto(string Package, string VersionRange);
internal sealed record PackageDependencyGroupDto(Dictionary<string, List<PackageDependencyDto>> Frameworks);
internal sealed record PackageDetailsDto(PackageDependencyGroupDto Dependencies)
{
    public static PackageDetailsDto Empty() => new(new PackageDependencyGroupDto(new()));
}

internal sealed record LocalPackageInfo(
    string Id,
    NuGetVersion Version,
    List<string> Authors,
    string Description,
    string IconUrl,
    string LicenseUrl,
    string ProjectUrl,
    List<string> Tags,
    List<PackageDependencyGroup> DependencyGroups,
    string Path)
{
    public PackageDto ToPackage(IEnumerable<NuGetVersion> versions)
    {
        return new PackageDto
        {
            Id = Id,
            Name = Id,
            Authors = Authors,
            Description = Description,
            IconUrl = IconUrl,
            LicenseUrl = LicenseUrl,
            ProjectUrl = ProjectUrl,
            Registration = string.Empty,
            TotalDownloads = 0,
            Verified = false,
            Version = Version.ToNormalizedString(),
            Versions = versions
                .OrderBy(x => x)
                .Select(x => new PackageVersionDto(x.ToNormalizedString(), x.ToNormalizedString()))
                .ToList(),
            Tags = Tags
        };
    }
}

internal sealed record PackageDto
{
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public List<string> Authors { get; init; } = new();
    public string Description { get; init; } = string.Empty;
    public string IconUrl { get; init; } = string.Empty;
    public string LicenseUrl { get; init; } = string.Empty;
    public string ProjectUrl { get; init; } = string.Empty;
    public string Registration { get; init; } = string.Empty;
    public long TotalDownloads { get; init; }
    public bool Verified { get; init; }
    public string InstalledVersion { get; init; } = string.Empty;
    public string Version { get; init; } = string.Empty;
    public List<PackageVersionDto> Versions { get; init; } = new();
    public List<string> Tags { get; init; } = new();
}

internal static class JsonOptions
{
    public static JsonSerializerOptions Create()
    {
        return new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = false
        };
    }
}
