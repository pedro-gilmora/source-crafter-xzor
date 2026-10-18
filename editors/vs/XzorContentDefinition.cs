using System.ComponentModel.Composition;
using Microsoft.VisualStudio.LanguageServer.Client;
using Microsoft.VisualStudio.Utilities;

namespace Xzor.VisualStudio;

/// <summary>The <c>xzor</c> content type: a remote-code type, so the LSP client and the TextMate grammar both apply.</summary>
#pragma warning disable CS0649 // MEF reads the attributes; the fields stay null.
public static class XzorContentDefinition
{
    [Export]
    [Name("xzor")]
    [BaseDefinition(CodeRemoteContentDefinition.CodeRemoteContentTypeName)]
    internal static ContentTypeDefinition? XzorContentType;

    [Export]
    [FileExtension(".xzor")]
    [ContentType("xzor")]
    internal static FileExtensionToContentTypeDefinition? XzorFileExtension;
}
