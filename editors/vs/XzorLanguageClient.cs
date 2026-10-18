using System;
using System.Collections.Generic;
using System.ComponentModel.Composition;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.VisualStudio.LanguageServer.Client;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Microsoft.VisualStudio.Threading;
using Microsoft.VisualStudio.Utilities;

namespace Xzor.VisualStudio;

/// <summary>Starts <c>xzor lsp</c> the first time a <c>.xzor</c> document opens; Visual Studio keeps one per solution.</summary>
[ContentType("xzor")]
[Export(typeof(ILanguageClient))]
[RunOnContext(RunningContext.RunOnHost)]
public sealed class XzorLanguageClient : ILanguageClient
{
    public string Name => "XZor";

    public IEnumerable<string>? ConfigurationSections => null;

    public object? InitializationOptions => null;

    public IEnumerable<string>? FilesToWatch => null;

    public bool ShowNotificationOnInitializeFailed => true;

    public event AsyncEventHandler<EventArgs>? StartAsync;

#pragma warning disable CS0067 // Part of ILanguageClient; the server is never stopped from here.
    public event AsyncEventHandler<EventArgs>? StopAsync;
#pragma warning restore CS0067

    public async Task<Connection?> ActivateAsync(CancellationToken token)
    {
        string server = StableCopy(await FindServerAsync());
        var info = new ProcessStartInfo(server, "lsp")
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        Process? process = Process.Start(info);
        return process is null ? null : new Connection(process.StandardOutput.BaseStream, process.StandardInput.BaseStream);
    }

    public async Task OnLoadedAsync()
    {
        if (StartAsync is not null) await StartAsync.InvokeAsync(this, EventArgs.Empty);
    }

    public Task OnServerInitializedAsync() => Task.CompletedTask;

    public Task<InitializationFailureContext?> OnServerInitializeFailedAsync(ILanguageClientInitializationInfo initializationState) =>
        Task.FromResult<InitializationFailureContext?>(new InitializationFailureContext
        {
            FailureMessage = $"The xzor language server failed to start: {initializationState.InitializationException?.Message}. Set XZOR_SERVER_PATH or install @source-crafter/xzor.",
        });

    /// <summary>
    /// Same order as the VS Code extension: <c>XZOR_SERVER_PATH</c>, the newest <c>target/{release,debug}/xzor.exe</c> of the
    /// solution folder, the npm platform package, the binary shipped in this extension, then <c>xzor</c> on PATH.
    /// </summary>
    private static async Task<string> FindServerAsync()
    {
        string? configured = Environment.GetEnvironmentVariable("XZOR_SERVER_PATH");
        if (!string.IsNullOrEmpty(configured) && File.Exists(configured)) return configured!;
        const string exe = "xzor.exe";
        string? folder = await SolutionFolderAsync();
        if (folder is not null)
        {
            string? built = new[] { "release", "debug" }
                .Select(profile => Path.Combine(folder, "target", profile, exe))
                .Where(File.Exists)
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .FirstOrDefault();
            if (built is not null) return built;
            string arch = Environment.Is64BitOperatingSystem && System.Runtime.InteropServices.RuntimeInformation.OSArchitecture == System.Runtime.InteropServices.Architecture.Arm64 ? "arm64" : "x64";
            string installed = Path.Combine(folder, "node_modules", "@source-crafter", $"xzor-cli-win32-{arch}", exe);
            if (File.Exists(installed)) return installed;
        }
        string shipped = Path.Combine(Path.GetDirectoryName(typeof(XzorLanguageClient).Assembly.Location)!, "server", exe);
        return File.Exists(shipped) ? shipped : "xzor";
    }

    private static async Task<string?> SolutionFolderAsync()
    {
        await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
        if (await AsyncServiceProvider.GlobalProvider.GetServiceAsync(typeof(SVsSolution)) is not IVsSolution solution) return null;
        solution.GetSolutionInfo(out string directory, out _, out _);
        return string.IsNullOrEmpty(directory) ? null : directory;
    }

    /// <summary>Runs a copy of a workspace build, so the running server doesn't lock <c>target/</c> and block <c>cargo build</c>.</summary>
    private static string StableCopy(string server)
    {
        string normalized = server.Replace('/', '\\');
        if (!normalized.Contains("\\target\\release\\") && !normalized.Contains("\\target\\debug\\")) return server;
        string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "xzor", "vs");
        Directory.CreateDirectory(dir);
        string copy = Path.Combine(dir, $"xzor-{File.GetLastWriteTimeUtc(server).Ticks}.exe");
        if (!File.Exists(copy)) File.Copy(server, copy);
        return copy;
    }
}
